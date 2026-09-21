import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKILL_ROOT = path.join(PACKAGE_ROOT, "skills", "plangonaut");
const VERSION = fs.readFileSync(path.join(PACKAGE_ROOT, "VERSION"), "utf8").trim();
const SCHEMA_VERSION = 3;


const PROJECT_MODES = new Set(["Genesis", "Adoption", "Reconstruction", "Evolution", "Resume"]);
const INTERACTION_MODES = new Set(["Guided", "Standard", "Expert"]);
const MODULE_STATUSES = new Set(["NOT STARTED", "IN DISCUSSION", "CONFIRMED", "PARTIAL", "DEFERRED", "NOT APPLICABLE", "BLOCKED"]);
const OWNER_KEYS = ["product", "technical", "budget", "safety", "release"];
const LIFECYCLE_STATES = new Set(["INTAKE", "DISCOVERY", "INTERVIEW", "RESEARCH", "BLUEPRINT", "FOUNDATION", "PLAN", "EXECUTE", "VERIFY", "RELEASE", "OPERATE"]);

// D5 / FR-024. The vocabulary is the user's, recorded in Italian in
// `planning/CLAUDE_PROGRESS_FORECAST_ADDENDUM.md`, and it is stored verbatim
// rather than translated: the person who reads it back is the person who wrote it.
const CONFIDENCE_LEVELS = ["ALTA", "MEDIA", "BASSA"];
const CYCLE_STATES = ["REGOLARE", "IN_ESPANSIONE", "RISCHIO_LOOP", "BLOCCATO"];
// Ordered, because the engine has to be able to say "the signals imply more than
// you recorded" without being able to say "so I changed it".
const CYCLE_STATE_RANK: Record<string, number> = { REGOLARE: 0, IN_ESPANSIONE: 1, RISCHIO_LOOP: 2, BLOCCATO: 3 };
const TASK_STATUSES = ["BACKLOG", "READY", "IN_PROGRESS", "REVIEW", "DONE", "BLOCKED"];
const MODULE_TERMINAL_STATUSES = new Set(["CONFIRMED", "DEFERRED", "NOT APPLICABLE"]);
const OPEN_RISK_STATUSES = new Set(["IDENTIFIED", "REALIZED"]);
const CLOSED_RISK_STATUSES = new Set(["MITIGATED", "ACCEPTED"]);

/**
 * What kind of refusal this is, for a caller that cannot read English.
 *
 * Three values, deliberately few. They are the distinctions a program has to
 * act on differently, not a taxonomy of everything that can go wrong:
 *
 *   NOT_PLANGONAUT_PROJECT  there is no project at the root that was asked
 *                           about, in either format. Offer to initialise one.
 *   PROJECT_STATE_AMBIGUOUS both `.plangonaut/` and `.beave/` are present. The
 *                           engine refuses to choose; a person decides which is
 *                           the project.
 *   MIGRATION_INCOMPLETE    a `migrate-brand` run did not finish. The remedy is
 *                           to complete it or roll it back, which is not the
 *                           remedy for an ambiguous project — hence its own kind.
 *   PROJECT_STATE_UNTRUSTED there is one, and its state, schema, events or
 *                           replay do not agree. Offer to repair; do not read
 *                           the state as fact.
 *   COMMAND_FAILED          everything else — a bad option, a stale revision, a
 *                           refused precondition. The project is fine.
 *
 * A new kind is a contract change, so the set stays small on purpose. A caller
 * that handles these and treats anything unrecognised as COMMAND_FAILED keeps
 * working when one is added.
 *
 * **The old spelling is still understood.** `NOT_BEAVE_PROJECT` was this
 * vocabulary's name for the first of these before the product was renamed, and
 * adapters written against it are still in use. `interpretErrorKind` maps it to
 * the current name on the way in; nothing emits it any more.
 */
type ErrorKind =
  | "NOT_PLANGONAUT_PROJECT"
  | "PROJECT_STATE_AMBIGUOUS"
  | "MIGRATION_INCOMPLETE"
  | "PROJECT_STATE_UNTRUSTED"
  | "COMMAND_FAILED";

/**
 * Every spelling a caller may send us, resolved to the one we act on.
 *
 * Reading direction only. A machine code is part of a published contract, so an
 * adapter compiled against `0.2.x` keeps working; but a project created by this
 * version is described in this version's words, and nothing here emits a legacy
 * code. The map is the compatibility window written down rather than implied.
 */
const LEGACY_ERROR_KINDS: Record<string, ErrorKind> = {
  NOT_BEAVE_PROJECT: "NOT_PLANGONAUT_PROJECT",
};

export function interpretErrorKind(value: string): ErrorKind | null {
  if (LEGACY_ERROR_KINDS[value]) return LEGACY_ERROR_KINDS[value];
  const known: ErrorKind[] = [
    "NOT_PLANGONAUT_PROJECT",
    "PROJECT_STATE_AMBIGUOUS",
    "MIGRATION_INCOMPLETE",
    "PROJECT_STATE_UNTRUSTED",
    "COMMAND_FAILED",
  ];
  return known.includes(value as ErrorKind) ? (value as ErrorKind) : null;
}

class PlangonautError extends Error {
  readonly kind: ErrorKind;
  constructor(message: string, kind: ErrorKind = "COMMAND_FAILED") {
    super(message);
    this.kind = kind;
  }
}

function now(): string {
  return new Date().toISOString();
}

/**
 * One environment variable, under either of its two names.
 *
 * The rename gives every `BEAVE_*` hook a `PLANGONAUT_*` spelling. A harness,
 * a script or a CI job written against the old one keeps working — but it is
 * told, once, that the name it used has been superseded, because a silent
 * compatibility shim is how a deprecation window never closes.
 *
 * The one case that refuses is both names present with **different** values.
 * There is no defensible winner: picking the new one silently discards a
 * deliberate setting, and picking the old one silently ignores the current
 * name. So the caller is asked which they meant.
 */
const ENV_NOTICES = new Set<string>();

function readEnv(name: string): string | undefined {
  const legacy = name.replace(/^PLANGONAUT_/, "BEAVE_");
  const current = process.env[name];
  const previous = legacy === name ? undefined : process.env[legacy];

  if (current !== undefined && previous !== undefined && current !== previous) {
    throw new PlangonautError(
      `${name} and ${legacy} are both set, to different values.
` +
        `  ${name}=${current}
  ${legacy}=${previous}
` +
        `${legacy} is the superseded name. Unset it, or make the two agree. Nothing was read.`,
    );
  }
  if (current !== undefined) {
    if (previous !== undefined && !ENV_NOTICES.has(legacy)) {
      ENV_NOTICES.add(legacy);
      console.error(`Note: ${legacy} is superseded by ${name}, which is set to the same value. ${legacy} can be removed.`);
    }
    return current;
  }
  if (previous !== undefined && !ENV_NOTICES.has(legacy)) {
    ENV_NOTICES.add(legacy);
    console.error(`Note: ${legacy} is the pre-rename name of ${name} and is still honoured. Prefer ${name}.`);
  }
  return previous;
}

function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonicalSourceDigest(): string {
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const location = path.join(directory, entry.name);
      if (entry.isDirectory() && entry.name !== "__pycache__") visit(location);
      else if (entry.isFile() && !entry.name.endsWith(".pyc")) files.push(location);
    }
  };
  visit(SKILL_ROOT);
  files.sort((left, right) => {
    const a = path.relative(SKILL_ROOT, left).replaceAll("\\", "/");
    const b = path.relative(SKILL_ROOT, right).replaceAll("\\", "/");
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const digest = crypto.createHash("sha256");
  for (const location of files) {
    digest.update(path.relative(SKILL_ROOT, location).replaceAll("\\", "/"));
    digest.update("\0");
    digest.update(fs.readFileSync(location));
    digest.update("\0");
  }
  return digest.digest("hex");
}

interface Flags {
  [key: string]: string | boolean | undefined;
}

interface Project {
  name: string;
  root: string;
  mode: string;
}

interface Module {
  id: number;
  title: string;
  status: string;
  owner?: string | null;
  evidence?: string | null;
  evidence_sha256?: string;
  summary?: string | null;
  updated_at?: string | null;
}

/**
 * One superseded source of a governed record, kept when `re-record` re-points it.
 *
 * `path`/`sha256` are what the record used to claim. They are `null` when there
 * was nothing to claim — a gate recorded before the gate record kept its evidence
 * — which is a different fact from "the previous digest matched", and the two are
 * not allowed to look alike.
 */
interface RecordedSourceSupersession {
  path: string | null;
  sha256: string | null;
  superseded_at: string;
  superseded_by: string;
  reason: string;
  event_id: string;
}

interface Override {
  id: string;
  status: string;
  owner: string;
  reason: string;
  source: string;
  source_sha256: string;
  summary: string;
  created_at: string;
  reconciled_by?: string;
  reconciled_at?: string;
  reconciliation_evidence?: string;
  reconciliation_sha256?: string;
  source_history?: RecordedSourceSupersession[];
}

interface Decision { id: string; title: string; status: string; owner: string; revision: number; updated_at: string; }
interface Requirement { id: string; title: string; status: string; owner: string; revision: number; updated_at: string; }
/**
 * A document lock: a session that is editing, not a name that was here once.
 *
 * `lock_owner` was a bare string, set by every write and cleared by nothing.
 * A real project therefore carried `"studio:Ale92"` for ever: the tab was
 * closed, the application was closed, the machine was rebooted, and the value
 * stayed, because no code path in either implementation ever assigned an empty
 * one. A second author could not finalize the document, and `validate --strict`
 * passed throughout — correctly, because nothing about it is invalid. It is a
 * persistent value describing something that was never persistent.
 *
 * So the lock records enough to be *checked* rather than merely believed:
 * which host, which process, which session, and when. A lock whose host is this
 * one and whose process is gone is demonstrably over. A lock from another host
 * is not, and is never touched automatically.
 */
interface DocumentLock {
  /** The owner who holds the editing session. */
  owner: string;
  /** The editing session or operation this lock belongs to. */
  session: string;
  /** The machine that holds it. A lock from elsewhere is never assumed dead. */
  host: string;
  /** The process, when the holder could name one. `null` is not a licence. */
  pid: number | null;
  acquired_at: string;
  /** Updated by a renewal, when a holder renews. */
  renewed_at?: string | null;
}

interface Artifact {
  id: string;
  base_path: string;
  working_path: string;
  status: string;
  revision: number;
  content_hash: string;
  /**
   * The legacy field, kept and still honoured.
   *
   * Every project written before this carries it and nothing else, and reading
   * it as "unlocked" would be the one fix the brief forbids. It stays as the
   * name of the holder; `lock` carries the evidence when there is any.
   */
  lock_owner: string;
  /** The structured lock. Absent means either unlocked or a legacy lock. */
  lock?: DocumentLock | null;
  provenance: string[];
}
/**
 * A task, and everything a task needs before somebody who was not here can do it.
 *
 * The four required fields are the record as it shipped and they stay required.
 * Everything below them is optional, and has to be: a project written under
 * alpha.5 carries none of it, and inventing a value for a field nobody filled
 * would be worse than reporting that it is missing. Absent means **not
 * assessed**, which is what every reader of this record prints.
 *
 * Why the fields are these fields. The pilot held 82 decisions, 33 requirements
 * and three tasks, all administrative, and every command called it healthy —
 * because a task was a title and a status, and a title cannot tell anybody what
 * the work is for, who does it, or how anyone would know it was done. These are
 * the columns that turn a list of intentions into a thing that can be executed
 * and checked.
 */
interface Task {
  id: string;
  title: string;
  status: string;
  owner: string;
  revision: number;
  updated_at: string;
  /**
   * What kind of work this is.
   *
   * The distinction the pilot needed and did not have. `ADMINISTRATIVE` is not
   * a lesser status — setting up a repository is real work — but a plan made
   * entirely of it is not a plan to build anything, and nothing could say so.
   * Absent is not `ADMINISTRATIVE`: it is unknown, and is reported as unknown.
   */
  kind?: string;
  /** Requirement ids this task exists to satisfy. */
  requirements?: string[];
  /** Decision ids that determine how it is done. */
  decisions?: string[];
  /** The component, area or work package it belongs to. */
  component?: string;
  /** The role accountable for doing it, from the approved organisation. */
  role?: string;
  /** What has to be true for this to be finished. */
  acceptance?: string;
  /** How that is checked. */
  verification?: string;
  /** What the check leaves behind. */
  evidence_expected?: string;
  /** Whether it may run beside its siblings. */
  parallelizable?: boolean;
  /** What is handed to whom when it is done. */
  handoff?: string;
  /** Relative size, in whatever unit the project chose. */
  estimate?: string;
  /** Inputs it needs before it can start. */
  inputs?: string[];
  /** What it produces. */
  outputs?: string[];
  /** Risk ids it carries. */
  risks?: string[];
}
interface Dependency { id: string; from: string; to: string; type: string; owner: string; revision: number; updated_at: string; }
interface Gate {
  id: string;
  name: string;
  status: string;
  // Everything below arrived after the record shipped as `{id, name, status}`.
  // A gate written before that carries none of it, which is why `validate` has to
  // treat an absent digest as "nothing was claimed" rather than as a failure.
  owner?: string;
  evidence?: string | null;
  evidence_sha256?: string | null;
  updated_at?: string;
  consequence?: string | null;
  review_date?: string | null;
  source_history?: RecordedSourceSupersession[];
}
interface Risk { id: string; title: string; severity: string; status: string; owner: string; revision: number; updated_at: string; }
interface Evidence { id: string; path: string; sha256: string; owner: string; revision: number; updated_at: string; }
/**
 * An executor: a person, an organisation, or an agent.
 *
 * Named `Agent` because the ledger is, and the ledger is not renamed for a
 * project that builds a bridge. What it records is who does a piece of the work
 * and what they are allowed to do, which is the same question in software and
 * out of it.
 */
interface Agent {
  id: string;
  name: string;
  status: string;
  owner: string;
  revision: number;
  updated_at: string;
  /** What this executor is for, in the approved organisation. */
  role?: string;
  /** What they are competent to do. */
  skills?: string[];
  /** Components or work packages they own outright. */
  owns?: string[];
  /** What they may decide without asking. */
  authority?: string;
  /** Whether this executor integrates others' work. */
  integrator?: boolean;
  /** Whether this executor reviews others' work. */
  reviewer?: boolean;
}
interface Operation { id: string; type: string; status: string; }

/**
 * One file, read once, by somebody, for a reason.
 *
 * `sha256` is what makes this evidence rather than a claim: the file can be
 * re-hashed later and the record either still describes it or demonstrably does
 * not. That is the whole difference between "I read it" and "this was read, and
 * here is what it said at the time".
 */
interface ReadRecord {
  id: string;
  /** Project-relative. A read of something outside the folder is recorded as such. */
  path: string;
  sha256: string;
  read_at: string;
  /** Who did the reading: an agent id, a model name, or a person. */
  agent: string;
  /** Why it was read. A read with no purpose is a file access, not evidence. */
  purpose: string;
  /** What was concluded from it. */
  conclusions?: string;
  /** Records that rest on this read. */
  used_by?: string[];
  owner: string;
  revision: number;
  updated_at: string;
}
interface Checkpoint { id: string; name: string; owner: string; revision: number; created_at: string; updated_at: string; }

/**
 * A quantity expressed as a range, which is the only way D5 allows one to be
 * expressed.
 *
 * `min === max` is not a rounding artefact: it means the quantity is **known**.
 * The engine stores a single supplied number that way and prints it as "N (known)"
 * so a reader cannot mistake certainty for a range that happens to be narrow.
 *
 * There is no percentage field here and none anywhere else in the record. A
 * percentage whose denominator can still change is the exact thing
 * `docs/decisions/2026-09-10-progress-forecast-and-loop-detection.md` forbids, so
 * the engine refuses one at the command line rather than storing it.
 */
interface ForecastRange { min: number; max: number; }

/**
 * What the engine counted for itself, from the ledgers, at the moment the
 * forecast was recorded.
 *
 * Never supplied by the caller: `plangonaut forecast` has no option that writes any of
 * it. The addendum's rule is that the caller describes the work and the engine
 * counts what it can already see, so that a forecast can be checked against the
 * project rather than only believed.
 */
interface ForecastDerived {
  open_blockers: number;
  open_overrides: number;
  tasks_by_status: Record<string, number>;
  gates_remaining: number;
  unresolved_modules: number[];
  // Beyond the five the contract names, and needed by the signals:
  //  - `open_findings` is what the fourth loop condition means by "rilievi": risks
  //    still IDENTIFIED or REALIZED.
  //  - `evidence_records` is what "without producing new evidence" is measured on.
  //  - `status_history_events` is how many ledger events in this project recorded
  //    the status of the record they changed. It is 0 for every project written
  //    before ALN-008, and when it is 0 the reopening signal cannot be derived at
  //    all. The number is stored so that the absence of that signal can be read as
  //    "not observable here" instead of as "did not happen".
  open_findings: number;
  evidence_records: number;
  status_history_events: number;
}

/**
 * One D5 condition the engine observed for itself in the recorded data.
 *
 * `implies_cycle_state` is what the requirement says the condition raises — "at
 * least RISCHIO LOOP" — and it is advisory: nothing in this file ever writes it
 * into `cycle_state`. `observed` is a finished sentence, because the skill and
 * Studio both have to show the observed cause and neither should be inventing the
 * wording.
 */
interface ForecastSignal {
  code: string;
  implies_cycle_state: string;
  observed: string;
  detail: Record<string, unknown>;
}

/** One recorded forecast. `progress_forecast` holds the current one; `forecast_history[]` every previous one, in order. */
interface ProgressForecast {
  phase: string;
  known_work: string;
  conditional_work: string;
  questions: ForecastRange;
  operations: ForecastRange;
  cycles: ForecastRange;
  confidence: string;
  confidence_reason: string;
  cycle_state: string;
  change_reason: string | null;
  recorded_by: string;
  /**
   * Whose numbers these are: the agent's estimate, or the user's commitment.
   *
   * `recorded_by` is the owner under whose authority the command ran, which is
   * not the same fact and was being read as though it were. A forecast an agent
   * produced then appeared in the folder as a statement by a person — ranges,
   * confidence, loop risk and all — and the next reader had no way to tell an
   * estimate from an undertaking. Optional, because a project written before
   * this release records neither, and absent means unknown rather than human.
   */
  authored_by?: "agent" | "human";
  recorded_at: string;
  state_revision: number;
  derived: ForecastDerived;
  signals: ForecastSignal[];
}

interface State {
  schema_version: number;
  beave_version: string;
  /**
   * The engine that most recently committed to this project.
   *
   * Optional, and it has to stay optional: a project written before this
   * field existed does not carry it and is not invalid. Absent means the
   * information was never recorded, which is a different statement from the
   * engine never having changed, and `status` says which of the two it is
   * looking at rather than merging them.
   */
  last_engine_version?: string;
  project: Project;
  interaction_mode: string;
  intake_strategy: string;
  decision_owners: Record<string, string>;
  lifecycle_state: string;
  current_gate: string;
  modules: Module[];
  
  decisions: Decision[];
  requirements: Requirement[];
  artifacts: Artifact[];
  tasks: Task[];
  dependencies: Dependency[];
  gates: Gate[];
  risks: Risk[];
  evidence: Evidence[];
  agents: Agent[];
  operations: Operation[];
  checkpoints: Checkpoint[];

  /**
   * The blocker ledger.
   *
   * **Heterogeneous on purpose.** Every project written before `ALN-015` holds
   * plain strings here — a sentence somebody typed into the state file, with no
   * owner, no date and no status. Those stay exactly as they are: converting one
   * into a record would mean inventing the three fields it never had, and a
   * fabricated owner is worse than an unattributed sentence. A legacy string is
   * read as **open**, because a blocker whose status was never recorded has not
   * been recorded as resolved.
   */
  blockers: (string | Blocker)[];
  /**
   * The last time somebody said, on the record, that they looked and found none.
   *
   * Absent on every project that predates `ALN-015`, and absent again the moment
   * any blocker is recorded or resolved — a verification is a statement about a
   * particular state of the ledger, and the ledger changing makes it stale
   * rather than merely older. This is what separates `NONE_VERIFIED` from
   * `UNKNOWN`; without it an empty list would slide back into meaning "none",
   * which is the defect this whole field exists to prevent.
   */
  blockers_none_verified?: BlockerVerification | null;
  risks_legacy?: string[];
  evidence_legacy?: string[];
  // Both optional, and they have to stay optional. A project that has never
  // recorded a forecast is not an invalid project, and the two ALN-005 pilots are
  // the real prior projects that prove it: neither carries either field and both
  // must keep answering "Plangonaut state is valid.".
  progress_forecast?: ProgressForecast;
  forecast_history?: ProgressForecast[];
  /**
   * The interview ledger, and the same reasoning as the two fields above: a
   * project created before it existed is valid and carries none. `undefined`
   * therefore means "this project predates the ledger", which is a different
   * statement from `[]` — "recording is on and nothing has been asked yet" — and
   * Resume says which of the two it is looking at rather than merging them.
   */
  interview_log?: InterviewEntry[];
  /** When recording began. Nothing before this instant is claimed either way. */
  interview_log_since?: string;
  /** Digest of the derived document, so a hand edit to it is detectable. */
  interview_view?: { path: string; sha256: string } | null;
  /**
   * Which directories this project governs, what it deliberately does not, and
   * what documentation was already in the folder.
   *
   * Optional for the same reason the two ledgers above are: a project written by
   * an earlier engine does not carry it and is not invalid. Its absence is read
   * as "nothing was recorded about this folder's existing documents", which is
   * narrower than an empty list and is treated as such — see `unclaimedDocuments`.
   */
  document_governance?: {
    directories: string[];
    exclusions: string[];
    preexisting: string[] | null;
  };
  /**
   * Whether this project is meant to be built, declared rather than guessed.
   *
   * A feasibility study, a concept note, a tender document and a proposal are
   * all finished work, and none of them has tasks, roles or an integration
   * plan. A project that is merely unfinished looks identical from the outside.
   * The engine cannot tell those two apart and must not try: absence of tasks
   * is evidence of nothing, and inferring "they must have meant definition
   * only" is precisely how the pilot came to be called complete.
   *
   * So it is recorded, by a human authority, with a reason, through
   * `execution-intent`. Absent means nobody has said, which is reported as
   * `NOT DECLARED` and is the state every alpha.5 project is in.
   */
  execution_intent?: {
    /** `DEFINITION_ONLY` or `EXECUTION`. */
    mode: string;
    reason: string;
    declared_by: string;
    declared_at: string;
    operation_id: string;
  } | null;
  /**
   * The approved organisation of whoever does the work.
   *
   * Recorded only after a human approves it. The proposal is the skill's job —
   * it has read the decomposition and can see which work is independent — and
   * the approval is the user's. What is stored is the outcome of that exchange,
   * so that `status` can say the plan of responsibilities is settled without
   * anybody having to remember the conversation.
   *
   * A single executor still fills this in. "One agent" answers the question of
   * how many, and leaves every other question — who reviews, when work is
   * handed over, what stops — exactly where it was.
   */
  execution_organization?: {
    /** How many executors the approved shape has. */
    executors: number;
    /** Human, agents, or both. */
    mode: string;
    /** The id of the executor that integrates, or null when one person does everything. */
    integrator: string | null;
    /** The id of the executor that reviews, or null with the reason recorded. */
    reviewer: string | null;
    /** How concurrent writes are prevented. */
    concurrency: string;
    /** When work passes from one executor to another. */
    handoff: string;
    approved_by: string;
    approved_at: string;
    operation_id: string;
  } | null;
  /**
   * Files somebody read and built on.
   *
   * The pilot produced a turn in which the agent stated it had read two files
   * in full, and a later turn in which it stated nobody had ever read them.
   * Both were assertions about the past with nothing behind them, and the
   * project had no way to prefer one. A read that a plan rests on is a fact
   * about the project, and facts about the project belong in the ledger with a
   * digest, like every other.
   */
  reads?: ReadRecord[];
  human_overrides: Override[];
  needs_reconciliation: boolean;
  revision: number;
  last_event_id: string;
  exact_next_action: string;
  created_at?: string;
  updated_at?: string;
}

// Flags that stand alone: they carry approval, not a value.
/**
 * How many questions one block of the interview holds by default.
 *
 * A presentation figure and nothing else: it does not bound the interview,
 * which ends when every applicable module is closed with a reason.
 */
const QUESTION_BLOCK_DEFAULT = 5;
/** The largest block `next` will lay out at once, so one call stays readable. */
const QUESTION_BLOCK_MAX = 20;

/*
 * The block size a project has settled on, and the difference between having
 * one and not.
 *
 * The number itself was never the hard part. What was, is that a user who says
 * "give me three at a time" tells that to an agent in a conversation, and the
 * next agent to open the folder reads the folder. Every other thing a person
 * decides about this project is written down; this one was being held in a chat
 * window, which is precisely the failure the whole product is about.
 *
 * Absent is a state, not a zero. A project written before this field existed has
 * no preference recorded, and that is a different fact from having chosen five.
 * Nothing backfills it: the field appears when somebody sets it and not before,
 * so `recorded: false` keeps meaning "nobody said" for as long as it is true.
 */
function questionBlockSize(state: State): { effective: number; recorded: boolean } {
  const value = (state as any).question_block_size;
  if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= QUESTION_BLOCK_MAX) {
    return { effective: value, recorded: true };
  }
  return { effective: QUESTION_BLOCK_DEFAULT, recorded: false };
}

/** One reading of `--count`, refused the same way wherever it arrives. */
function parseBlockSize(value: unknown, option: string): number {
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1 || count > QUESTION_BLOCK_MAX) {
    throw new PlangonautError(
      `${option} must be a whole number between 1 and ${QUESTION_BLOCK_MAX}. ` +
      `It sizes one block; it does not limit how many blocks an interview has.`
    );
  }
  return count;
}

const BOOLEAN_FLAGS = new Set(["dry-run", "resume", "discard-changes", "accept-base-overwrite", "replace-human-next-action", "planned", "reconstructed", "regenerate", "open", "last", "json", "verify", "repair", "apply", "force", "crosscutting", "strict", "help", "migrate-backups", "remember", "definition-only", "execution", "parallelizable", "is-integrator", "is-reviewer"]);

/** Line separator used where a template literal would be harder to read. */
const NL = "\n";

/**
 * The interview ledger.
 *
 * `PLANNED` is a question Plangonaut intends to ask; `ASKED` has been put to the user
 * and has no answer yet; `ANSWERED` has one. Whether that answer has been
 * *applied* to the project's records is deliberately **not** a status: it is
 * `consequences_recorded_at`, a timestamp written by the one command that
 * records consequences. A word can be set by the command that sets the status; a
 * timestamp that says "applied" can only be written by the code that applied it.
 * That distinction is the whole point of the state -- an interrupted turn must
 * never look finished.
 */
const QA_STATUSES = new Set([
  "PLANNED",
  "ASKED",
  "ANSWERED",
  "DEFERRED",
  "SKIPPED",
  "SUPERSEDED",
  "INVALIDATED",
]);

/** Statuses that close an entry without an answer, and why each needs a reason. */
const QA_CLOSE_KINDS = new Set(["deferred", "skipped", "invalidated"]);

/** The derived, human-readable rendering, at the project root so it is visible. */
const QA_VIEW_RELATIVE = "QUESTION_ANSWER_HISTORY.md";

const QA_ID_PATTERN = /^QNA-[0-9]{4,}$/;

/**
 * The options each command actually consumes.
 *
 * Anything else is refused. It used to be accepted and dropped: `task --title X
 * --description Y --acceptance Z` printed "Created task" and stored only the
 * title, and `init --owners-file` with a `compliance` key succeeded while
 * discarding it. A user who supplies a compliance owner for a CE-marked product
 * has every reason to believe it was recorded (ALN-005 pilot B).
 *
 * The eight ledger commands share one set. It is wider than any single one of
 * them needs — `--severity` is meaningful only to `risk` — so it catches an
 * unknown option without also rejecting an option that another ledger command
 * legitimately takes. Narrowing it per kind is a further improvement, not a
 * prerequisite for closing the silent-loss defect.
 */
const COMMAND_OPTIONS: Record<string, string[]> = {
  capabilities: [],
  version: [],
  help: [],
  init: ["project-root", "project-name", "project-mode", "interaction-mode", "owners-file", "operation-id"],
  status: ["project-root"],
  // Reads with `--project-root` alone; `--remember` is what makes it write, the
  // same shape `replay --repair` and `recover --apply` already have.
  next: ["project-root", "count", "remember", "owner", "operation-id"],
  resume: ["project-root"],
  validate: ["project-root", "strict"],
  "migrate-backups": ["project-root", "apply"],
  "handoff-check": ["project-root", "json"],
  // The *document* lock. The project lock is `unlock`, and the two are kept
  // apart by name so nobody reaches for the wrong one in a hurry.
  "doc-lock": ["project-root", "id", "session", "json"],
  "doc-lock-acquire": ["project-root", "id", "owner", "session", "pid", "json", "operation-id"],
  "doc-lock-release": ["project-root", "id", "owner", "json", "operation-id"],
  "doc-lock-recover": ["project-root", "id", "owner", "json", "operation-id"],
  "doc-lock-force-release": ["project-root", "id", "owner", "reason", "json", "operation-id"],
  // The three states of completeness, and the two things a project records
  // about how it will be executed.
  "execution-readiness": ["project-root", "json"],
  // Asked by a different process in a different language: the writer says what
  // it can do and gets an answer about itself, not about this engine.
  "compat-check": ["project-root", "json", "writer-engine", "writer-version", "writer-schema", "writer-event-format", "writer-reads-formats"],
  "execution-intent": ["project-root", "definition-only", "execution", "reason", "owner", "operation-id"],
  "execution-org": ["project-root", "executors", "mode", "integrator", "reviewer", "concurrency", "handoff", "owner", "operation-id"],
  "read-record": ["project-root", "path", "purpose", "agent", "conclusions", "used-by", "owner", "operation-id"],
  govern: ["project-root", "exclude", "include", "reason", "owner", "operation-id"],
  migrate: ["project-root", "operation-id"],
  "migrate-brand": ["project-root", "dry-run", "resume", "rollback", "discard-changes"],
  // Reading and repairing are the same command because they answer the same
  // question; `--repair` is what turns the answer into a write, and it needs an
  // operation id like every other mutation.
  replay: ["project-root", "verify", "repair", "operation-id"],
  baseline: ["project-root", "reason", "owner", "operation-id", "dry-run", "confirm-token"],
  // `--apply` is the write. Without it the command reports and touches nothing:
  // the command someone runs when something has gone wrong should not be the one
  // that changes things.
  recover: ["project-root", "apply"],
  // The only route that removes a lock this process does not hold, which is why
  // it is a command a person runs rather than something a retry does.
  unlock: ["project-root", "force"],
  record: ["project-root", "module", "status", "answer-file", "owner", "summary", "operation-id"],
  /*
   * ALN-015. Hyphenated, not `blocker record`.
   *
   * `parse()` takes argv[0] as the whole command name and everything after it as
   * `--flags`; there is no subcommand level to put a second word on, and adding
   * one would change how every existing command is parsed. Every multi-word
   * command already here is hyphenated for the same reason — `doc-save`,
   * `qa-answer`, `project-import`, `re-record`, `verify-install`.
   */
  "blocker-record": ["project-root", "id", "title", "reason", "owner", "evidence-file", "expected-revision", "operation-id"],
  "blocker-resolve": ["project-root", "id", "resolution", "owner", "evidence-file", "expected-revision", "operation-id"],
  "blocker-verify-none": ["project-root", "owner", "note", "operation-id"],
  override: ["project-root", "instruction-file", "owner", "reason", "operation-id"],
  // OD-012. `override` creates; this re-points what an existing record stands on.
  "re-record": ["project-root", "kind", "id", "source-file", "owner", "reason", "operation-id"],
  // `--next-action` is optional here on purpose (blocker 1): making it mandatory
  // is what forced operators to overwrite a sentence a person had written.
  reconcile: ["project-root", "override-id", "evidence-file", "owner", "next-action", "replace-human-next-action", "operation-id"],
  // D5/FR-024. With `--project-root` alone it reads, like `status`; with any of the
  // others it records. `derived` and `signals` have no options on purpose — they
  // are what the engine counted, not what the caller asserted.
  forecast: [
    "project-root", "owner", "phase", "known-work", "conditional-work", "questions", "operations",
    "cycles", "confidence", "confidence-reason", "cycle-state", "change-reason", "author",
    "expected-revision", "operation-id",
  ],
  gate: ["project-root", "id", "status", "evidence-file", "owner", "consequence", "review-date", "operation-id"],
  decision: ["project-root", "id", "title", "name", "status", "severity", "owner", "from", "to", "type", "file", "next-action", "provenance-override", "provenance-note", "expected-revision", "operation-id"],
  requirement: ["project-root", "id", "title", "name", "status", "severity", "owner", "from", "to", "type", "file", "next-action", "expected-revision", "operation-id"],
  // Everything after `next-action` is optional and is what turns a title
  // into work somebody who was not here can pick up.
  task: ["project-root", "id", "title", "name", "status", "severity", "owner", "from", "to", "type", "file", "next-action", "kind", "requirements", "decisions", "component", "role", "acceptance", "verification", "evidence-expected", "parallelizable", "handoff", "estimate", "inputs", "outputs", "risks", "expected-revision", "operation-id"],
  dependency: ["project-root", "id", "title", "name", "status", "severity", "owner", "from", "to", "type", "file", "next-action", "expected-revision", "operation-id"],
  risk: ["project-root", "id", "title", "name", "status", "severity", "owner", "from", "to", "type", "file", "next-action", "expected-revision", "operation-id"],
  evidence: ["project-root", "id", "title", "name", "status", "severity", "owner", "from", "to", "type", "file", "next-action", "expected-revision", "operation-id"],
  agent: ["project-root", "id", "title", "name", "status", "severity", "owner", "from", "to", "type", "file", "next-action", "role", "skills", "owns", "authority", "is-integrator", "is-reviewer", "expected-revision", "operation-id"],
  checkpoint: ["project-root", "id", "title", "name", "status", "severity", "owner", "from", "to", "type", "file", "next-action", "expected-revision", "operation-id"],
  // A preview takes exactly what the save it previews takes. The intended
  // workflow is "run doc-diff with the arguments you are about to run doc-save
  // with", and a narrower list would refuse that.
  // `--session` and `--pid` are accepted and change nothing: a preview belongs
  // to the same editing session as the save it precedes, and a caller that
  // passes the pair to both should not be refused by the half that writes
  // nothing.
  "doc-diff": ["project-root", "id", "base-path", "content-file", "owner", "sources", "confirm-token", "expected-revision", "expected-hash", "session", "pid"],
  "doc-mark-deletion": ["project-root", "id", "target", "reason-file", "content-file", "owner", "expected-revision", "expected-hash", "json", "operation-id"],
  "doc-save": ["project-root", "id", "base-path", "content-file", "owner", "sources", "confirm-token", "expected-revision", "expected-hash", "session", "pid", "json", "operation-id"],
  "doc-history": ["project-root", "id"],
  "doc-restore": ["project-root", "id", "revision", "owner", "expected-revision", "expected-hash", "json", "operation-id"],
  "doc-finalize": ["project-root", "id", "owner", "accept-base-overwrite", "expected-revision", "expected-hash", "json", "operation-id"],
  "context-pack": ["project-root", "output"],
  "project-export": ["project-root", "output-dir"],
  "project-verify": ["package-dir"],
  "project-import": ["package-dir", "project-root", "operation-id"],
  export: ["target", "output-dir"],
  install: ["target", "scope", "project-root", "dry-run"],
  "verify-install": ["target", "scope", "project-root"],
  // The interview ledger. Three commands for three moments, because they are
  // three moments: a question put, an answer received, and the answer applied.
  // Collapsing them would make an interrupted turn indistinguishable from a
  // finished one, which is the failure the ledger exists to prevent.
  "qa-ask": [
    "project-root", "id", "question", "question-file", "rationale", "rationale-file",
    "module", "owner", "agent", "planned", "reconstructed", "reconstructed-from", "operation-id",
    "crosscutting", "crosscutting-reason",
  ],
  "qa-answer": ["project-root", "id", "answer", "answer-file", "owner", "agent", "operation-id"],
  "qa-settle": [
    "project-root", "id", "interpretation", "interpretation-file", "reply", "reply-file",
    "consequences", "documents", "open-points", "next-id", "next-question",
    "next-question-file", "next-rationale", "next-module", "owner", "operation-id",
    // The answer that finishes a module closes it in the same transaction, using
    // the rules `record` uses rather than a second copy of them.
    "complete-module", "module-answer-file", "module-summary",
  ],
  "qa-close": ["project-root", "id", "kind", "reason", "reason-file", "owner", "operation-id"],
  "qa-supersede": [
    "project-root", "id", "new-id", "question", "question-file", "rationale", "rationale-file",
    "reason", "reason-file", "module", "owner", "agent", "operation-id",
    "crosscutting", "crosscutting-reason",
  ],
  "qa-log": ["project-root", "open", "last", "json", "regenerate", "id"],
};

/**
 * The option table, for a check that reads the documentation.
 *
 * Exported so a test can hold every published example against the real command
 * surface instead of against a second list of it. The pilot's agent ran the
 * skill's first `qa-ask` example and was refused for a missing `--operation-id`;
 * none of the three examples in that section had one, while `user-guide.md`'s did.
 * Nobody had a way to notice, because nothing compared the prose to the parser.
 * Now something does, and an example that would not run fails the build instead
 * of an agent.
 */
export function commandSurface(): {
  options: Record<string, string[]>;
  booleans: string[];
  mutating: string[];
} {
  return {
    options: Object.fromEntries(Object.entries(COMMAND_OPTIONS).map(([name, list]) => [name, [...list]])),
    booleans: [...BOOLEAN_FLAGS],
    // A command is mutating if its own option list admits `--operation-id`:
    // that is what `assertKnownOptions` enforces, so the two cannot drift.
    mutating: Object.entries(COMMAND_OPTIONS)
      .filter(([name, list]) => list.includes("operation-id") && name !== "migrate-brand")
      .map(([name]) => name)
      .sort(),
  };
}

function assertKnownOptions(command: string, flags: Flags): void {
  const allowed = COMMAND_OPTIONS[command];
  if (!allowed) return;
  // Two options are accepted everywhere and are not command input.
  //
  // `--operation-id` is caller identity: required by every mutation, harmless on
  // a read, and refusing it on a read would break the ordinary pattern of passing
  // one command's arguments to the command that previews it.
  //
  // `--idempotency-key` is a deliberate distinguisher. Every flag except the
  // operation id feeds the idempotency payload hash, so an otherwise-identical
  // repeat of an operation is recognised as a retry — and this is how a caller
  // says "this really is a second, different operation". That is also the reason
  // unknown options could not simply be ignored: they were never inert, they
  // silently changed which operations counted as the same one.
  const universal = new Set(["operation-id", "idempotency-key"]);
  const unknown = Object.keys(flags).filter((key) => !universal.has(key) && !allowed.includes(key));
  if (!unknown.length) return;
  throw new PlangonautError(
    `Unknown option${unknown.length > 1 ? "s" : ""} for ${command}: ${unknown.map((key) => `--${key}`).join(", ")}. ` +
      `Accepted: ${allowed.map((key) => `--${key}`).join(", ")}. Nothing was written — an option Plangonaut does not store is refused rather than dropped.`
  );
}

function parse(argv: string[]): { command: string; flags: Flags } {
  const [command, ...rest] = argv;
  const flags: Flags = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) throw new PlangonautError(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    if (BOOLEAN_FLAGS.has(key)) {
      flags[key] = true;
      continue;
    }
    const value = rest[index + 1];
    // `!value` also rejected an empty string, which is a *supplied* value, not a
    // missing one. It surfaced the moment a refused preview started withholding
    // its confirmation token: a caller forwarding that empty token was told
    // "Missing value for --confirm-token" instead of the reason the preview was
    // refused in the first place.
    if (value === undefined || value.startsWith("--")) throw new PlangonautError(`Missing value for --${key}`);
    // A repeated option used to overwrite the earlier one without a word:
    // `--sources DEC-1 --sources DEC-2` recorded provenance on DEC-2 alone, and
    // the caller was told the save succeeded. Same family as an unknown option —
    // supplied input discarded in silence — so it gets the same answer.
    if (Object.prototype.hasOwnProperty.call(flags, key)) {
      throw new PlangonautError(
        `Option --${key} was given more than once, and only the last value would have been kept. Supply it once; a list goes in one value, comma-separated. Nothing was written.`
      );
    }
    flags[key] = value;
    index += 1;
  }
  return { command, flags };
}

/**
 * Which command is running, for the error messages that need to name it.
 *
 * `required()` is called from about two hundred places and none of them passes
 * the command name; threading it through all of them to improve one sentence
 * would be a larger change than the defect. This is set once, at dispatch,
 * before anything is read or written.
 */
let CURRENT_COMMAND = "";

function required(flags: Flags, key: string): string {
  const val = flags[key];
  if (typeof val !== "string") {
    throw new PlangonautError(
      CURRENT_COMMAND ? missingOptionMessage(CURRENT_COMMAND, key) : `Missing required option --${key}. Nothing was written.`
    );
  }
  return val;
}

function resolveProject(value: string): string {
  const root = path.resolve(value);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    // Not a directory at all, so certainly not a project in one. A caller
    // deciding whether to offer "initialise Plangonaut here" needs this to land in
    // the same branch as an ordinary folder rather than in the generic one.
    throw new PlangonautError(`Project root is not a directory: ${root}`, "NOT_PLANGONAUT_PROJECT");
  }
  return root;
}

/**
 * Where a project keeps its ledger, in the two spellings that exist.
 *
 * `.plangonaut/` is canonical. `.beave/` is what every project created before
 * the rename has, and reading it is not a courtesy: a project is somebody's
 * recorded work, and a tool that stops reading it has deleted it as far as they
 * are concerned.
 */
const STATE_DIR = ".plangonaut";
const LEGACY_STATE_DIR = ".beave";

/**
 * What a migration in flight is called on disk.
 *
 * The staging directory is deliberately **not** `.plangonaut`: a half-built
 * ledger that the resolver counts as an active state would make the project
 * ambiguous for the whole duration of its own migration, and an interruption
 * would leave it ambiguous forever. `.plangonaut-migration-<id>/` is recognised
 * as staging and never as state.
 */
const MIGRATION_MARKER = ".plangonaut-migration.json";
const MIGRATION_STAGING_PREFIX = ".plangonaut-migration-";

export type StateFormat = "plangonaut" | "legacy";

export interface StateLocation {
  /** Which spelling this project uses. */
  format: StateFormat;
  /** The directory name, `.plangonaut` or `.beave`. */
  name: string;
  /** The resolved absolute path. */
  dir: string;
  /** True while the project is being read in its pre-rename format. */
  legacy: boolean;
}

/**
 * Which of the five conditions this root is in.
 *
 * Returns a location for the two that have one, and throws for the three that
 * do not — each with its own machine kind, because the remedies differ and a
 * caller that cannot tell them apart cannot offer the right next step:
 *
 *   both directories      a person decides which is the project. Refusing is the
 *                         whole point: a silent preference would eventually
 *                         write half a project's history into the directory
 *                         nobody was reading, and neither half would be wrong
 *                         enough to notice.
 *   migration unfinished  complete it or roll it back. Not the same as
 *                         ambiguous, although it looks identical on disk.
 *   neither               not a project here.
 */
function locateState(root: string): StateLocation {
  /*
   * A root that is not there yet.
   *
   * `project-import` asks about its destination before creating it, and the
   * containment check below resolves real paths, which a directory that does
   * not exist has none of. There is no state in a folder that does not exist,
   * so the answer is the canonical location and no refusal — the caller is
   * about to create the folder, or about to fail on its own terms.
   */
  if (!fs.existsSync(root)) {
    return { format: "plangonaut", name: STATE_DIR, dir: path.resolve(root, STATE_DIR), legacy: false };
  }
  const realRoot = fs.realpathSync.native(root);
  const contained = (target: string): string => {
    const resolved = fs.existsSync(target) ? fs.realpathSync.native(target) : target;
    if (path.relative(realRoot, resolved).startsWith("..")) throw new PlangonautError("State must stay inside the project root");
    return target;
  };

  const current = contained(path.resolve(root, STATE_DIR));
  const legacy = contained(path.resolve(root, LEGACY_STATE_DIR));
  const hasCurrent = fs.existsSync(current);
  const hasLegacy = fs.existsSync(legacy);

  // The marker is read before the directories are counted: an interrupted
  // migration leaves exactly the shape an ambiguous project has, and the
  // difference between "somebody has two projects here" and "a command of ours
  // stopped halfway" is the difference between two unrelated remedies.
  const marker = path.join(root, MIGRATION_MARKER);
  if (fs.existsSync(marker)) {
    throw new PlangonautError(
      `A brand migration at ${root} did not finish: ${MIGRATION_MARKER} is still there.\n` +
        `Nothing was read. Finish it or undo it:\n` +
        `  plangonaut migrate-brand --project-root . --resume\n` +
        `  plangonaut migrate-brand --project-root . --rollback`,
      "MIGRATION_INCOMPLETE",
    );
  }

  if (hasCurrent && hasLegacy) {
    throw new PlangonautError(
      `${root} has both ${STATE_DIR}/ and ${LEGACY_STATE_DIR}/, and only one of them can be the project.\n` +
        `Nothing was read and nothing was changed. This is not something to guess at: whichever one is\n` +
        `not the project is somebody's earlier work, and writing into the wrong one loses it quietly.\n` +
        `Move or remove the directory that is not the project, then run the command again.`,
      "PROJECT_STATE_AMBIGUOUS",
    );
  }

  if (hasCurrent) return { format: "plangonaut", name: STATE_DIR, dir: current, legacy: false };
  if (hasLegacy) return { format: "legacy", name: LEGACY_STATE_DIR, dir: legacy, legacy: true };

  // Neither exists. The caller is either about to create one (`init`) or about
  // to fail on a missing `state.json` with a message of its own, and both want
  // the canonical path rather than a refusal from here.
  return { format: "plangonaut", name: STATE_DIR, dir: current, legacy: false };
}

/**
 * The project's state directory.
 *
 * Unchanged as a signature on purpose: fifty-eight call sites read a path out of
 * this function, and a rename that made each of them decide between two
 * directories would be fifty-eight chances to decide differently.
 */
function stateRoot(root: string): string {
  return locateState(root).dir;
}

/** Whether this project is being read in its pre-rename format. */
export function stateFormat(root: string): StateFormat {
  return locateState(root).format;
}

function boundedOutput(base: string, relative: string): string {
  const candidate = path.join(base, relative);
  let probe = path.dirname(candidate);
  while (!fs.existsSync(probe) && probe !== path.dirname(base)) probe = path.dirname(probe);
  const realBase = fs.realpathSync.native(base);
  const realProbe = fs.realpathSync.native(probe);
  const rebuilt = path.join(realProbe, path.relative(probe, candidate));
  if (path.relative(realBase, rebuilt).startsWith("..")) throw new PlangonautError("Output path resolves outside the approved state directory");
  return candidate;
}

/**
 * One leading UTF-8 byte-order mark, and nothing else.
 *
 * Windows PowerShell 5.1 writes one in front of every file `Set-Content
 * -Encoding utf8` produces, so the first file a Windows user creates —
 * `owners.json`, for the very first Plangonaut command — looks correct in every
 * editor and is refused by `JSON.parse`. The tutorial documented a workaround
 * (`[System.IO.File]::WriteAllText`) for a defect that should not have needed
 * one (ALN-009).
 *
 * Exactly one mark, and only at position 0. A second mark, a mark anywhere else,
 * and anything else that is not valid JSON are still refused: this accepts a
 * known encoding artefact, it does not become tolerant of damaged input.
 */
function stripLeadingBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function readJson(location: string, kind: ErrorKind = "COMMAND_FAILED"): any {
  try {
    const value = JSON.parse(stripLeadingBom(fs.readFileSync(location, "utf8")));
    if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("expected an object");
    return value;
  } catch (error: any) {
    // The caller says what an unreadable file means here: a corrupt state file
    // is an untrustworthy project, while a malformed file somebody passed on the
    // command line is just a bad argument.
    throw new PlangonautError(`Cannot read JSON ${location}: ${error.message}`, kind);
  }
}

/** Where the backups of project files live, under the ledger and not beside them. */
const DOCUMENT_BACKUPS = "backups/documents";

/**
 * The copy kept of whatever a write is about to replace, and where it goes.
 *
 * For a file inside the ledger this has always been `.plangonaut/backups/`, and
 * that is right. For a file in the project it was `backups/` **next to the file**
 * — so a governed document in `docs/` left copies in `docs/backups/`, and the
 * interview view at the root left them in the root. The pilot's folder had 21 of
 * them there, untracked, and they were the first thing `git status` showed on a
 * project that was otherwise clean. A tool that asks not to be written outside
 * its own directory should not be the one writing outside it.
 *
 * With `root`, a file outside the state directory backs up under
 * `.plangonaut/backups/documents/`, keeping its project-relative path in the
 * name so `docs/a.md` and `notes/a.md` cannot collide. Without `root` — the
 * ledger's own files — nothing changes.
 */
function backupName(location: string, root?: string): string {
  const stamp = new Date().toISOString().replaceAll(":", "").replaceAll(".", "");
  if (root) {
    const ledger = stateRoot(root);
    const insideLedger = !path.relative(ledger, location).startsWith("..") && !path.isAbsolute(path.relative(ledger, location));
    if (!insideLedger) {
      const relative = canonicalRelative(path.relative(root, location)) || path.basename(location);
      return path.join(ledger, ...DOCUMENT_BACKUPS.split("/"), `${relative.replaceAll("/", "__")}.${stamp}.bak`);
    }
  }
  return path.join(path.dirname(location), "backups", `${path.basename(location)}.${stamp}.bak`);
}

function atomicWrite(location: string, content: string | Buffer, root?: string): void {
  fs.mkdirSync(path.dirname(location), { recursive: true });
  if (fs.existsSync(location)) {
    const existing = fs.readFileSync(location);
    const next = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    // A backup exists so the previous bytes stay recoverable. When the new
    // content *starts with* the previous content the write is a pure append:
    // every one of those bytes is still there afterwards, so the copy protects
    // nothing and costs a full duplicate of the file.
    //
    // Measured on the ALN-005 pilot A project: 482 backup files, 104.1 MB,
    // against 220 KB of governed documents — 485 to 1. `events.jsonl` was 86.8 MB
    // of that, because every mutation copied the whole append-only log, so the
    // cost grew with the *square* of the number of operations: ~1.8 GB projected
    // at 1000 mutations, on a project that had not written a line of software.
    // `state.json` is rewritten wholesale and still gets a copy every time, which
    // is the one you actually roll back to.
    const pureAppend =
      next.length >= existing.length && next.subarray(0, existing.length).equals(existing);
    if (!pureAppend) {
      const backup = backupName(location, root);
      fs.mkdirSync(path.dirname(backup), { recursive: true });
      fs.copyFileSync(location, backup);
    }
  }
  const temporary = path.join(path.dirname(location), `.${path.basename(location)}.${crypto.randomUUID()}.tmp`);
  const handle = fs.openSync(temporary, "wx");
  try {
    fs.writeFileSync(handle, content);
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  fs.renameSync(temporary, location);
}

// ---------------------------------------------------------------------------
// Durable history: canonical form, state patches and the event chain
//
// The engine used to record *digests* of what changed — `question_sha256`,
// `record_revision` — and nothing else. That is enough to prove a record was not
// altered afterwards and not nearly enough to rebuild it, so "the events are the
// history" was a sentence no code supported: no command has ever re-read them.
//
// The fix is not a hand-written reducer per event type. Thirty types today, one
// more with every command, each free to forget a field the day it is added: that
// is a matrix that goes stale silently, and the brief's own warning — do not call
// the replay complete if some fields are quietly copied from `state.json` — names
// exactly how it would fail.
//
// So the mutation itself is recorded. `commitState` computes the difference
// between the state on disk and the state about to be written, stores it as the
// event's `state_patch`, and **verifies before writing** that applying that patch
// to the previous state reproduces the new one digest for digest. An event that
// cannot rebuild its own effect is refused. Completeness is therefore a property
// of every single write rather than a claim about the collection.
// ---------------------------------------------------------------------------

/** The event shape this engine writes. Older events stay exactly as they are. */
const EVENT_FORMAT = 2;
/** The reducer that reads them. Bumped when replay semantics change. */
const REDUCER_VERSION = 1;

type PatchOp = { op: "set" | "del" | "trim"; path: Array<string | number>; value?: unknown };

/**
 * Serialization that depends on content and never on insertion order.
 *
 * `JSON.stringify` writes keys in the order the object happens to hold them, so
 * two states that are the same state produce different bytes — and a digest over
 * those bytes would report a difference nobody made. Keys are sorted, `undefined`
 * properties are dropped exactly as `JSON.stringify` drops them when writing the
 * file, so the digest of a state in memory equals the digest of the same state
 * read back from disk.
 */
function canonicalJson(value: unknown): string {
  if (value === null || value === undefined || typeof value !== "object") {
    return JSON.stringify(value === undefined ? null : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

function digestOf(value: unknown): string {
  return sha256(canonicalJson(value));
}

/**
 * The difference between two states, as operations a reducer can apply.
 *
 * Three operations, and no more: `set` a path, `del` an object key, `trim` an
 * array to a length. A ledger grows by appending, so the ordinary patch is one
 * `set` at one index; nothing here is tuned for that case, it simply falls out
 * of comparing index by index.
 */
function diffValue(before: unknown, after: unknown, at: Array<string | number>, out: PatchOp[]): void {
  if (canonicalJson(before) === canonicalJson(after) && (before !== undefined || after === undefined)) return;
  const comparable =
    before !== null &&
    before !== undefined &&
    after !== null &&
    after !== undefined &&
    typeof before === "object" &&
    typeof after === "object" &&
    Array.isArray(before) === Array.isArray(after);
  if (!comparable) {
    out.push({ op: "set", path: at, value: after === undefined ? null : after });
    return;
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    const shared = Math.min(before.length, after.length);
    for (let index = 0; index < shared; index += 1) diffValue(before[index], after[index], [...at, index], out);
    if (after.length > before.length) {
      for (let index = before.length; index < after.length; index += 1) {
        out.push({ op: "set", path: [...at, index], value: after[index] === undefined ? null : after[index] });
      }
    } else if (after.length < before.length) {
      out.push({ op: "trim", path: at, value: after.length });
    }
    return;
  }
  const left = before as Record<string, unknown>;
  const right = after as Record<string, unknown>;
  for (const key of Object.keys(left).sort()) {
    if (!(key in right) || right[key] === undefined) out.push({ op: "del", path: [...at, key] });
  }
  for (const key of Object.keys(right).sort()) {
    if (right[key] === undefined) continue;
    // A key the previous state did not carry is always written out: comparing
    // `undefined` with `null` would otherwise look like no change and leave the
    // key missing after a replay.
    if (!(key in left)) out.push({ op: "set", path: [...at, key], value: right[key] });
    else diffValue(left[key], right[key], [...at, key], out);
  }
}

function applyPatch(base: unknown, ops: unknown): unknown {
  if (!Array.isArray(ops)) throw new PlangonautError("Event carries no state patch; it was written by an engine that did not record one.");
  let root: any = base === undefined || base === null ? null : structuredClone(base);
  for (const candidate of ops) {
    const op = candidate as PatchOp;
    if (!op || typeof op !== "object" || !Array.isArray(op.path)) throw new PlangonautError(`Malformed patch operation: ${JSON.stringify(candidate)}`);
    if (op.op !== "set" && op.op !== "del" && op.op !== "trim") throw new PlangonautError(`Unsupported patch operation "${(op as any).op}"; this engine reads reducer version ${REDUCER_VERSION}.`);
    if (!op.path.length) {
      if (op.op !== "set") throw new PlangonautError(`Patch operation "${op.op}" cannot apply to the whole state.`);
      root = structuredClone(op.value);
      continue;
    }
    let cursor: any = root;
    for (let index = 0; index < op.path.length - 1; index += 1) {
      const key = op.path[index];
      if (cursor === null || typeof cursor !== "object") throw new PlangonautError(`Patch path ${op.path.join("/")} does not exist in the state being rebuilt.`);
      if (cursor[key] === undefined) cursor[key] = typeof op.path[index + 1] === "number" ? [] : {};
      cursor = cursor[key];
    }
    if (cursor === null || typeof cursor !== "object") throw new PlangonautError(`Patch path ${op.path.join("/")} does not exist in the state being rebuilt.`);
    const last = op.path[op.path.length - 1];
    if (op.op === "set") cursor[last] = structuredClone(op.value);
    else if (op.op === "del") delete cursor[last];
    else {
      const target = cursor[last];
      if (!Array.isArray(target)) throw new PlangonautError(`Patch tried to trim ${op.path.join("/")}, which is not a list.`);
      target.length = Number(op.value);
    }
  }
  return root;
}

/** Every line of the event log, with the raw text each one was written as. */
function eventLines(root: string): Array<{ line: string; event: any; malformed: boolean }> {
  const location = path.join(stateRoot(root), "events.jsonl");
  if (!fs.existsSync(location)) return [];
  return fs
    .readFileSync(location, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return { line, event: JSON.parse(line), malformed: false };
      } catch {
        return { line, event: null, malformed: true };
      }
    });
}

function lastEventLine(root: string): { line: string; event: any } | null {
  const lines = eventLines(root);
  const last = lines[lines.length - 1];
  return last && !last.malformed ? { line: last.line, event: last.event } : null;
}

// ---------------------------------------------------------------------------
// The transaction journal
//
// `atomicWrite` makes one file replacement atomic. It does not make a *mutation*
// atomic: a save touches a document, the history folder, the event log, the state
// and a derived view, and an interruption between any two of them leaves a
// project that is half one thing and half another. A sequence of atomic renames
// is still a sequence.
//
// The journal is written before anything moves and names the point of no return:
// the moment the event is appended. Before it, an interrupted operation is rolled
// back and never happened. After it, the operation is completed from content the
// journal staged, because the history already says it happened and the honest
// repair is to make the project agree with its own history rather than to argue
// with it.
// ---------------------------------------------------------------------------

/**
 * Three phases, because three is how many the engine writes.
 *
 * A fourth — `APPLYING_FILES` — was declared here and handled in recovery and
 * never once set, which the same review caught by running all eight fault points
 * and seeing only these three. Recovery treated it exactly like `PREPARED`, so
 * it was a distinction with no behaviour behind it and a sentence in the
 * contract that described something that did not happen.
 */
type TransactionPhase = "PREPARED" | "COMMITTING" | "COMMITTED";

interface TransactionHandle {
  directory: string;
  root: string;
}

let activeTransaction: TransactionHandle | null = null;

/**
 * A deliberate crash, for the fault-injection tests and for nothing else.
 *
 * `process.exit` rather than a thrown error on purpose: an exception unwinds
 * through every `finally` and every `catch`, which is precisely the cleanup a
 * real interruption does not get. The tests run the CLI as a child process, so
 * what they observe is what a killed process leaves behind.
 */
function faultPoint(label: string): void {
  if (readEnv("PLANGONAUT_FAULT_AT") === label) {
    process.stderr.write(`BEAVE FAULT INJECTED: ${label}\n`);
    process.exit(97);
  }
}

// ---------------------------------------------------------------------------
// The project lock
//
// Everything below the journal assumed one writer. `appendEvent` reads the file,
// appends a line and writes it back, and `commitState` reads the state, computes
// a patch against it and writes the result: two processes that reach either at
// the same revision produce a lost event or a state built on a revision that has
// already moved. A review ran forty parallel mutations without a collision and
// said the right thing about it — an overlap that was never forced is not
// evidence of safety.
//
// The lock is a file created with `wx`: `O_CREAT | O_EXCL`, which is atomic on
// every platform Node supports, so the winner is decided by the filesystem and
// not by a check-then-act in this process.
//
// Three states are kept apart on purpose, because the wrong answer to any of
// them loses work:
//
//  - **held by a live process on this host** — refused, never taken. A slow
//    operation is not an abandoned one.
//  - **held by a dead process on this host** — taken over, and the takeover is
//    recorded. A process that was killed must not lock its project for ever.
//  - **held by another host, or unreadable** — refused, and no amount of waiting
//    changes it: this engine cannot ask a machine it cannot see whether a PID is
//    alive, and guessing would be how a shared folder loses a day's work. It
//    takes an explicit `plangonaut unlock --force`.
// ---------------------------------------------------------------------------

const LOCK_FILE = "lock.json";
/** How long a second process waits for a live holder before giving up. */
const LOCK_WAIT_MS = 10_000;
const LOCK_POLL_MS = 100;

interface LockRecord {
  lock_id: string;
  pid: number;
  host: string;
  at: string;
  command: string;
  operation_id: string | null;
  observed_revision: number | null;
  /** Present only when this lock was taken over from a process that had died. */
  took_over?: { lock_id: string; pid: number; at: string };
}

let runningCommand = "beave";
let heldLock: { file: string; record: LockRecord } | null = null;
let lockReleaseRegistered = false;

function lockFile(root: string): string {
  return path.join(stateRoot(root), LOCK_FILE);
}

/** Synchronous sleep with no dependency and no busy loop. */
function sleepMs(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

/**
 * Is this PID a process that still exists on this host?
 *
 * Signal 0 asks exactly that. `EPERM` means it exists and belongs to somebody
 * else, which still counts as alive: the one thing this must never do is report
 * a running process as dead.
 */
function processIsAlive(pid: unknown): boolean | null {
  // `null` is "cannot tell", and it is not the same answer as `false`. A pid this
  // engine cannot read is a pid it must not declare dead: the second review
  // showed a record with `"56404"` as a *string* being treated as a gone process
  // and its lock taken in silence, from a process that was running.
  const numeric = typeof pid === "number" ? pid : Number(pid);
  if (!Number.isInteger(numeric) || numeric <= 0) return null;
  try {
    process.kill(numeric, 0);
    return true;
  } catch (error: any) {
    return error?.code === "EPERM" ? true : false;
  }
}

function parseLockRecord(file: string): LockRecord | null {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return value as LockRecord;
  } catch {
    return null;
  }
}

/**
 * Read the lock, and do not mistake a lock being born for a broken one.
 *
 * `writeLockRecord` creates the file with `O_CREAT | O_EXCL` and fills it
 * immediately afterwards, which is what makes the acquisition atomic - but it
 * leaves a window of a few microseconds in which the file exists and is empty.
 * A second process reading in that window used to conclude the lock could not be
 * read, and that conclusion is expensive: it is a hard refusal telling a person
 * to go and delete a file by hand, produced by two perfectly ordinary commands
 * overlapping. It surfaced as one failing test in a suite that runs its files in
 * parallel, on a project neither test was writing to.
 *
 * So an unreadable lock has to stay unreadable to be believed. `patient` waits
 * out that window - briefly, and only while the file is still there - before
 * saying so. A lock that is genuinely damaged answers the same as before, a few
 * hundred milliseconds later.
 */
function readLockRecord(file: string, patient = false): LockRecord | null {
  const record = parseLockRecord(file);
  if (record || !patient) return record;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (!fs.existsSync(file)) return null;
    sleepMs(20);
    const retried = parseLockRecord(file);
    if (retried) return retried;
  }
  return null;
}

function describeLock(record: LockRecord | null, file: string): string {
  if (!record) return `The lock file at ${file} cannot be read, so Plangonaut cannot tell whether anything holds it.`;
  // A record with no host does not name a machine called "undefined".
  if (typeof record.host !== "string" || !record.host.trim()) {
    return `Held by ${record.command ?? "a Plangonaut command"} as process ${record.pid}, on a machine the lock does not name, since ${record.at}.`;
  }
  return (
    `Held by ${record.command ?? "a Plangonaut command"} as process ${record.pid} on ${record.host}, since ${record.at}` +
    `${record.operation_id ? `, operation ${record.operation_id}` : ""}` +
    `${record.observed_revision === null || record.observed_revision === undefined ? "" : `, at revision ${record.observed_revision}`}.`
  );
}

/**
 * A synchronisation point that exists for the concurrency tests and nothing else.
 *
 * `BEAVE_TEST_SYNC` names a path: once the process reaches the point named by
 * `BEAVE_TEST_SYNC_AT` it writes `<path>.ready` and waits for `<path>.go`, so two
 * processes can be made to overlap deterministically instead of being raced and
 * hoped over.
 *
 * There are two points, because the second independent review showed one is not
 * enough. `locked` -- the default -- stops a process just after it takes the lock,
 * which forces the overlap the lock is meant to refuse and demonstrates mutual
 * exclusion. It cannot demonstrate anything about the *read-modify-write* the lock
 * exists to protect: by the time the second process is running, the first has not
 * yet read `state.json`. `read` stops it just after it has read the revision it is
 * going to build on, which is the window in which a lost update is possible -- and
 * with the lock removed (`BEAVE_TEST_UNSAFE_NO_LOCK`) that window can be entered by
 * two processes at once and the damage observed. A guarantee is worth what its
 * counter-example costs to produce.
 */
function testSyncPoint(at: "locked" | "read" = "locked"): void {
  const marker = readEnv("PLANGONAUT_TEST_SYNC");
  if (!marker) return;
  if ((readEnv("PLANGONAUT_TEST_SYNC_AT") ?? "locked") !== at) return;
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(`${marker}.ready`, `${process.pid}\n`);
  const deadline = Date.now() + 60_000;
  while (!fs.existsSync(`${marker}.go`) && Date.now() < deadline) sleepMs(20);
}

/**
 * A file that exists only while an operation is in flight.
 *
 * `atomicWrite` keeps a copy of what it replaces under `backups/`, which is right
 * for a document and wrong for these: the lock record is rewritten by every
 * command, and the staging marker by every phase. The second review found both
 * consequences — an unbounded pile of `backups/lock.json.*.bak` in every project,
 * and, worse, a `backups/` directory *inside* every staging that was then renamed
 * into the package, so a handoff carried the exporter's hostname, PID and
 * absolute paths in files the manifest never declared.
 */
function writeTransientJson(location: string, value: unknown): void {
  fs.mkdirSync(path.dirname(location), { recursive: true });
  const temporary = path.join(path.dirname(location), `.${path.basename(location)}.${crypto.randomUUID()}.tmp`);
  const handle = fs.openSync(temporary, "wx");
  try {
    fs.writeFileSync(handle, `${JSON.stringify(value, null, 2)}${NL}`);
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  fs.renameSync(temporary, location);
}

function writeLockRecord(file: string, record: LockRecord): void {
  const handle = fs.openSync(file, "wx");
  try {
    fs.writeFileSync(handle, `${JSON.stringify(record, null, 2)}\n`);
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
}

/**
 * Take the project lock, or explain precisely why not.
 *
 * Acquired *before* recovery, before the idempotency question, before the
 * revision is read and before anything is written — the whole of what a command
 * does to a project happens inside it.
 */
function acquireProjectLock(root: string, command: string): void {
  if (heldLock) return;
  /*
   * The lock, removed on purpose, for the one test that has to show what it
   * prevents. Everything else here proves that a second process is kept out;
   * nothing proves that being kept out matters, and a guarantee nobody has seen
   * fail is a claim. The seam announces itself on stderr every time, because a
   * process that has disabled the exclusion it depends on must not look like an
   * ordinary one in a log.
   */
  if (readEnv("PLANGONAUT_TEST_UNSAFE_NO_LOCK") === "1") {
    process.stderr.write(`plangonaut: PLANGONAUT_TEST_UNSAFE_NO_LOCK is set - running WITHOUT the project lock (${command}). This is a test seam and it is not safe.\n`);
    return;
  }
  const file = lockFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const record: LockRecord = {
    lock_id: crypto.randomUUID(),
    pid: process.pid,
    host: os.hostname(),
    at: now(),
    command,
    operation_id: pendingOperation?.id ?? null,
    observed_revision: null,
  };

  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      writeLockRecord(file, record);
      heldLock = { file, record };
      if (!lockReleaseRegistered) {
        lockReleaseRegistered = true;
        // A normal exit releases it. A kill does not, which is the point: the
        // file left behind is what the next process reads to decide.
        process.on("exit", () => releaseProjectLock());
      }
      testSyncPoint();
      return;
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
    }

    const existing = readLockRecord(file, true);
    if (existing === null) {
      throw new PlangonautError(
        `This project is locked and the lock cannot be read: ${path.relative(root, file).replaceAll("\\", "/")}. ` +
          `Plangonaut will not remove a lock it cannot understand, and neither will \`plangonaut unlock --force\`: it has no way to tell whether a process is holding it. ` +
          `Make sure no Plangonaut command is running on this project, then delete that file yourself.`,
      );
    }
    if (typeof existing.host !== "string" || !existing.host.trim() || existing.host !== os.hostname()) {
      throw new PlangonautError(
        `This project is locked by another machine. ${describeLock(existing, file)} ` +
          `Plangonaut cannot ask that host whether the process is still running, so it will not take the lock on its own. ` +
          `If you are certain nothing is using the project, release it with: plangonaut unlock --project-root . --force`,
      );
    }
    const holderAlive = processIsAlive(existing.pid);
    if (holderAlive === null) {
      throw new PlangonautError(
        `This project is locked and the lock does not say which process holds it: ${path.relative(root, file).replaceAll("\\", "/")} records \`pid: ${JSON.stringify(existing.pid)}\`. ` +
          `Plangonaut will not take a lock it cannot reason about. Make sure no Plangonaut command is running, then delete that file yourself.`,
      );
    }
    if (holderAlive === false) {
      /*
       * A lock left by a process on this host that is certainly gone. Removing
       * it is safe *and* is recorded: the next lock says what it took over, so
       * an unexplained takeover cannot pass for an ordinary acquisition.
       */
      try {
        fs.rmSync(file, { force: true });
      } catch {
        // Somebody else won the race to clean it up; the next attempt decides.
      }
      record.took_over = { lock_id: existing.lock_id, pid: existing.pid, at: existing.at };
      continue;
    }
    if (Date.now() >= deadline) {
      throw new PlangonautError(
        `This project is in use by another Plangonaut process and did not become free within ${Math.round(LOCK_WAIT_MS / 1000)} seconds. ` +
          `${describeLock(existing, file)} Nothing was changed. Wait for it to finish and run the same command again.`,
      );
    }
    sleepMs(LOCK_POLL_MS);
  }
}

/** Record the revision this command actually observed, for the next reader. */
function noteObservedRevision(revision: number | null): void {
  if (!heldLock || revision === null || revision === undefined) return;
  heldLock.record.observed_revision = revision;
  try {
    writeTransientJson(heldLock.file, heldLock.record);
  } catch {
    // Diagnostics, not correctness: a project that cannot update its own lock
    // record still holds the lock.
  }
}

function releaseProjectLock(): void {
  if (!heldLock) return;
  const { file, record } = heldLock;
  heldLock = null;
  try {
    // Only if it is still ours. A lock taken over by somebody else after a
    // takeover must not be deleted by the process that lost it.
    const current = readLockRecord(file);
    if (current && current.lock_id !== record.lock_id) return;
    fs.rmSync(file, { force: true });
    /*
     * A refused command must leave no trace, including the `.beave` the lock had
     * to create to exist. Removed only when it is completely empty, which is
     * true exactly when nothing else was written -- a refused `init` -- and
     * never when a project is there.
     */
    const directory = path.dirname(file);
    if (fs.existsSync(directory) && fs.readdirSync(directory).length === 0) fs.rmdirSync(directory);
  } catch {
    // Nothing to do: the next process reads what is there and decides.
  }
}

/**
 * Release a lock this process does not hold.
 *
 * Deliberately a command of its own with `--force`: this is the only route that
 * removes a lock belonging to a live process or to another machine, and it has
 * to be something a person chose rather than something a retry did.
 */
/**
 * Who is holding this project, when anybody is.
 *
 * A short answer for the commands that must not run under somebody else's
 * lock. `unlock` reasons about the record in detail; this only has to say
 * whether one exists and who wrote it, and an unreadable record counts as held
 * — an unknown holder is the case to stop on, not the case to ignore.
 */
function projectLockHolder(root: string): string | null {
  const file = lockFile(root);
  if (!fs.existsSync(file)) return null;
  const record = readLockRecord(file, false);
  if (record === null) return "An unreadable lock record";
  /*
   * Our own lock is not another writer.
   *
   * Every command that loads a state takes the project lock, so a check for
   * "is anybody holding this" run from inside one finds itself. The first
   * version of this refused every baseline on that basis, which is the check
   * working perfectly and answering the wrong question.
   */
  if (Number((record as any).pid) === process.pid && (typeof record.host !== "string" || record.host === os.hostname())) {
    return null;
  }
  const owner = typeof (record as any).owner === "string" && (record as any).owner.trim() ? (record as any).owner.trim() : null;
  const host = typeof record.host === "string" && record.host.trim() ? record.host.trim() : "an unnamed machine";
  const writer = typeof (record as any).writer === "string" && (record as any).writer.trim() ? (record as any).writer.trim() : "another Plangonaut writer";
  return `${writer}${owner ? ` (${owner})` : ""} on ${host}`;
}

function unlock(flags: Flags): void {
  const root = resolveProject(required(flags, "project-root"));
  const file = lockFile(root);
  if (!fs.existsSync(file)) {
    console.log("This project is not locked.");
    return;
  }
  // Patient, for the same reason the acquisition is: this command's whole job is
  // to say what holds the lock, and "unreadable" is the one answer that sends a
  // person to delete a file by hand.
  const record = readLockRecord(file, true);
  const relative = path.relative(root, file).replaceAll("\\", "/");
  /*
   * A record that does not say which machine it came from is not a record from
   * another machine.
   *
   * `mine` was `record.host === os.hostname()`, so a lock with no `host` field,
   * or a blank one, fell into the another-machine branch — which `--force` is
   * allowed to release, deliberately, because this engine cannot ask a host it
   * cannot see. A third review wrote such a record naming a *live local* PID and
   * `--force` released it. A missing host is the unknown case, and unknown is
   * refused.
   */
  const host = typeof record?.host === "string" ? record.host.trim() : "";
  if (record !== null && !host) {
    console.log(`The lock at ${relative} does not say which machine holds it, and it records \`pid: ${JSON.stringify(record.pid)}\`.`);
    console.log("  state       unreadable: a lock with no host is one Plangonaut cannot reason about");
    console.log(`\nNothing was changed, and --force will not change it either. Make sure no Plangonaut command is running, then delete ${relative} yourself.`);
    if (flags.force === true) throw new PlangonautError(`Refusing to force a lock that does not name the machine holding it: ${relative}. Nothing was changed.`);
    return;
  }
  const mine = record !== null && host === os.hostname();
  // Three values, not two. `null` — the record cannot be read, or does not say
  // which process holds it — is the case the second review broke `--force` on:
  // it was folded into "not alive" and the lock was taken from a running process.
  const alive = record === null ? null : mine ? processIsAlive(record.pid) : false;

  if (flags.force !== true) {
    console.log(describeLock(record, relative));
    if (alive === null) console.log("  state       unreadable: Plangonaut cannot tell what holds it, or whether anything does");
    else if (!mine) console.log("  state       held by another machine, which this engine cannot ask about");
    else if (alive) console.log("  state       the process is still running on this machine");
    else console.log("  state       the process that took it is gone from this machine");
    console.log(
      alive === null
        ? `\nNothing was changed, and --force will not change it either: a lock Plangonaut cannot read is a lock it cannot reason about. Make sure no Plangonaut command is running, then delete ${relative} yourself.`
        : alive
          ? "\nNothing was changed. A running command is not an abandoned one: wait for it, or stop that process first."
          : "\nNothing was changed. Run the same command with --force to release it.",
    );
    return;
  }

  if (alive === null) {
    /*
     * The hole the second review found. An unreadable record made `mine` false
     * and `alive` false, the live-process guard did not fire, and `--force`
     * removed a lock a running process was holding — while the acquisition
     * message was busy telling the user to do exactly that.
     *
     * There is no safe automatic answer here: Plangonaut cannot tell whether anything
     * holds it. So it refuses and hands the decision to a person, in the same
     * words it uses for a journal it cannot read.
     */
    throw new PlangonautError(
      `${record === null ? "This lock cannot be read" : `This lock records \`pid: ${JSON.stringify(record.pid)}\`, which is not a process id`}, so Plangonaut cannot tell whether a process is holding it: ${relative}. ` +
        `--force will not remove it — that is how a running command loses its work. Make sure no Plangonaut command is running on this project, then delete that file yourself. Nothing was changed.`,
    );
  }

  if (alive) {
    throw new PlangonautError(
      `The process holding this lock is still running on this machine. ${describeLock(record, relative)} ` +
        `Plangonaut will not take a lock from a live process, with or without --force: stop that process first. Nothing was changed.`,
    );
  }
  fs.rmSync(file, { force: true });
  console.log(`Released the lock at ${relative}.`);
  console.log(record === null ? "It could not be read, so nothing is known about what held it." : describeLock(record, relative));
}

function transactionDirectory(root: string, eventId: string): string {
  return path.join(stateRoot(root), "transactions", eventId);
}

function journalPath(directory: string): string {
  return path.join(directory, "journal.json");
}

function writeJournal(directory: string, journal: any): void {
  journal.updated_at = now();
  // The journal is transient too, and it is rewritten at every phase.
  writeTransientJson(journalPath(directory), journal);
}

function setPhase(handle: TransactionHandle, phase: TransactionPhase): void {
  const journal = readJson(journalPath(handle.directory));
  journal.phase = phase;
  writeJournal(handle.directory, journal);
}

/**
 * Open a transaction over a set of files.
 *
 * `locations` are the files the operation is about to change *before* the event
 * is appended — documents, history entries, archived reasons. The state and the
 * event log are always covered and are not listed by the caller.
 */
function beginFileTransaction(root: string, event: any, locations: string[]): string {
  faultPoint("before-prepare");
  const directory = transactionDirectory(root, event.event_id);
  fs.mkdirSync(path.dirname(directory), { recursive: true });
  fs.mkdirSync(directory, { recursive: false });
  const unique = [...new Set([path.join(stateRoot(root), "state.json"), path.join(stateRoot(root), "events.jsonl"), ...locations].map((item) => path.resolve(item)))];
  const files = unique.map((location, index) => {
    const relative = path.relative(root, location);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new PlangonautError(`Transaction path escapes project root: ${location}`);
    const existed = fs.existsSync(location);
    const backup = existed ? `backup-${index}` : null;
    if (existed) copyFileCreatingParents(location, path.join(directory, backup!));
    return {
      path: relative.replaceAll("\\", "/"),
      existed,
      backup,
      before_sha256: existed ? sha256(fs.readFileSync(location)) : null,
    };
  });
  writeJournal(directory, {
    format: FILE_TRANSACTION_FORMAT,
    phase: "PREPARED" satisfies TransactionPhase,
    event_id: event.event_id,
    event_type: event.type,
    operation_id: pendingOperation?.id ?? null,
    operation_payload_hash: pendingOperation?.payloadHash ?? null,
    operation_payload_version: pendingOperation?.payloadVersion ?? null,
    idempotency_key: event.idempotency_key ?? null,
    state_revision: event.state_revision,
    created_at: event.at ?? now(),
    files,
    // Filled in by `commitState`, which is the only thing that knows them.
    staged: null,
  });
  faultPoint("after-journal");
  activeTransaction = { directory, root };
  return directory;
}

function rollbackFileTransaction(root: string, directory: string): void {
  const journal = readJson(journalPath(directory));
  const restored: string[] = [];
  for (const item of journal.files ?? []) {
    const destination = path.resolve(root, item.path);
    if (item.existed) {
      const backup = path.join(directory, item.backup);
      // `before_sha256` was recorded and never looked at. It is the one thing
      // that can tell a restored file from a restored *wrong* file, so it is
      // checked here and the result is written into the receipt.
      const intact = !item.before_sha256 || sha256(fs.readFileSync(backup)) === item.before_sha256;
      copyFileCreatingParents(backup, destination);
      restored.push(`${item.path}${intact ? "" : " (the backup no longer matches the digest recorded for it)"}`);
    } else if (fs.existsSync(destination)) {
      fs.rmSync(destination, { force: true });
      restored.push(`${item.path} (removed: it did not exist before)`);
    }
  }
  const recovery = path.join(stateRoot(root), "recovery", `${journal.event_id}.rolled-back.json`);
  writeJson(recovery, { ...journal, recovered_at: now(), outcome: "ABORTED", restored });
  fs.rmSync(directory, { recursive: true, force: true });
  if (activeTransaction?.directory === directory) activeTransaction = null;
}

function completeFileTransaction(directory: string): void {
  if (fs.existsSync(directory)) fs.rmSync(directory, { recursive: true, force: true });
  if (activeTransaction?.directory === directory) activeTransaction = null;
}

/**
 * Finish an operation the journal says had already passed the point of no return.
 *
 * Nothing here decides anything: the staged content is the exact content the
 * interrupted command had already computed and validated, and every file is left
 * carrying the digest the journal recorded for it.
 */
function rollForwardTransaction(root: string, directory: string, journal: any): string[] {
  const notes: string[] = [];
  const staged = journal.staged;
  const stagedStateFile = path.join(directory, "staged-state.json");
  /*
   * Everything the roll-forward needs is read before anything is written.
   *
   * This used to append the event and *then* read the staged state, so a journal
   * whose staged file was missing — the durability limit this contract itself
   * declares — left the event in the log, the state behind it, and every
   * subsequent command dying on a raw ENOENT with no way out. The refusal has to
   * come first for the promise above it to be true: it stops, it names the
   * directory, and it changes nothing.
   */
  if (!staged || !fs.existsSync(stagedStateFile)) {
    throw new PlangonautError(
      `Transaction ${journal.event_id} (${journal.event_type ?? "operation"}) passed the point of no return and its staged result is not there, so it can neither be completed nor safely undone. Nothing was changed.\n` +
        `Inspect ${path.relative(root, directory).replaceAll("\\", "/")}. If you are certain the operation should be abandoned, remove that directory and run: plangonaut replay --project-root . --repair --operation-id <id>`,
    );
  }
  const stagedState = fs.readFileSync(stagedStateFile, "utf8");

  const eventsLocation = path.join(stateRoot(root), "events.jsonl");
  const existing = fs.existsSync(eventsLocation) ? fs.readFileSync(eventsLocation, "utf8") : "";
  const alreadyAppended = existing.split(/\r?\n/).some((line) => {
    try { return JSON.parse(line).event_id === journal.event_id; } catch { return false; }
  });
  if (!alreadyAppended) {
    // Truncate any partial tail first: a half-written line is not an event, and
    // appending after it would produce two malformed ones instead of one.
    const prior = existing.slice(0, Number(staged.events_prior_bytes ?? 0));
    atomicWrite(eventsLocation, `${prior ? `${prior.replace(/\n+$/, "")}\n` : ""}${staged.event_line}\n`);
    notes.push("appended the recorded event");
  }

  const stateLocation = path.join(stateRoot(root), "state.json");
  if (!fs.existsSync(stateLocation) || sha256(fs.readFileSync(stateLocation)) !== staged.state_sha256_file) {
    atomicWrite(stateLocation, stagedState);
    notes.push("completed the state write");
  }
  return notes;
}

/**
 * Derived documents, rebuilt from the recovered state.
 *
 * They are never staged and never rolled forward: they are a pure function of
 * the state, so regenerating them is cheaper than transporting them and cannot
 * disagree with what they describe.
 */
function regenerateDerivedViews(root: string): string[] {
  const stateLocation = path.join(stateRoot(root), "state.json");
  if (!fs.existsSync(stateLocation)) return [];
  let state: any;
  try { state = readJson(stateLocation); } catch { return []; }
  if (!state || !state.interview_view || !Array.isArray(state.interview_log)) return [];
  const rendered = renderInterviewView(state);
  if (sha256(rendered) !== state.interview_view.sha256) return [];
  const file = path.join(root, QA_VIEW_RELATIVE);
  if (fs.existsSync(file) && sha256(fs.readFileSync(file)) === state.interview_view.sha256) return [];
  writeInterviewView(root, rendered);
  return [`regenerated ${QA_VIEW_RELATIVE}`];
}

/**
 * What a command does before it reads or writes anything.
 *
 * An interrupted transaction is never ignored and never left for later: it is
 * completed, undone, or the command stops and says why. "Later" is the state in
 * which a project looks fine and is not.
 */
/**
 * Interrupted operations resolved by the last run. Read by `resume`, which says
 * so out loud rather than letting a recovery pass unmentioned.
 */
let recoveredInThisRun: string[] = [];

function recoverFileTransactions(root: string): void {
  // Recovery is a mutation, so it is inside the lock like every other one. This
  // is also the single place the boundary is decided: every command that can
  // read a project and then change it -- or trigger a recovery by reading it --
  // arrives here or at `loadState`, which takes it too.
  acquireProjectLock(root, runningCommand);
  const transactions = path.join(stateRoot(root), "transactions");
  if (!fs.existsSync(transactions)) return;
  for (const entry of fs.readdirSync(transactions)) {
    const directory = path.join(transactions, entry);
    if (!fs.statSync(directory).isDirectory()) continue;
    const journalFile = journalPath(directory);
    const legacyFile = path.join(directory, "manifest.json");
    if (!fs.existsSync(journalFile)) {
      if (!fs.existsSync(legacyFile)) continue;
      recoverLegacyTransaction(root, directory, readJson(legacyFile));
      continue;
    }
    let journal: any;
    try {
      journal = readJson(journalFile);
    } catch {
      // Damage, and the honest answer is to say so rather than to die on a raw
      // JSON error inside whatever command happened to be entering the project.
      throw new PlangonautError(
        `The journal of an interrupted operation cannot be read: ${path.relative(root, journalFile).replaceAll("\\", "/")}. ` +
          `Plangonaut will not guess what it was doing, so nothing has been changed. Run \`plangonaut recover --project-root .\` to see what is there; ` +
          `once you have looked at it, remove that directory and run \`plangonaut replay --project-root . --verify\` to check what the project is.`,
      );
    }
    const notes: string[] = [];
    if (journal.phase === "PREPARED" || journal.phase === "APPLYING_FILES") {
      // `APPLYING_FILES` is accepted, never written: a journal from the build
      // that declared it is still resolved by the rule it was resolved by then.
      rollbackFileTransaction(root, directory);
      recoveredInThisRun.push(`${journal.event_type ?? "operation"} ${journal.event_id} (undone)`);
      process.stderr.write(`BEAVE RECOVERED: ${journal.event_type ?? "operation"} ${journal.event_id} was interrupted before it took effect and has been undone. The project is as it was before it started.\n`);
      continue;
    }
    if (journal.phase === "COMMITTING") notes.push(...rollForwardTransaction(root, directory, journal));
    // `regenerate_views` is what the operation said about itself. A commit that
    // touched no derived document does not need one rebuilt, and checking the
    // flag is the difference between using what the journal records and writing
    // it for decoration.
    if (journal.staged?.regenerate_views !== false) notes.push(...regenerateDerivedViews(root));
    const receipt = path.join(stateRoot(root), "recovery", `${journal.event_id}.recovered.json`);
    writeJson(receipt, { ...journal, recovered_at: now(), outcome: "RECOVERED", actions: notes });
    completeFileTransaction(directory);
    // Announced, never silent: a command that quietly finishes somebody else's
    // interrupted write is a command that hides an interruption. It goes to
    // stderr so a caller parsing JSON on stdout still gets JSON.
    recoveredInThisRun.push(`${journal.event_type ?? "operation"} ${journal.event_id} (${notes.join("; ") || "journal closed"})`);
    process.stderr.write(`BEAVE RECOVERED: ${journal.event_type ?? "operation"} ${journal.event_id} was interrupted after the point of no return and has been completed. ${notes.join("; ")}\n`);
  }
}

/** A journal written before the phases existed. Its rule is the one it shipped with. */
function recoverLegacyTransaction(root: string, directory: string, manifest: any): void {
  let state: any = null;
  try { state = readJson(path.join(stateRoot(root), "state.json")); } catch {}
  const committed = state?.revision >= manifest.state_revision && eventLines(root).some((item) => item.event?.event_id === manifest.event_id);
  if (committed) {
    completeFileTransaction(directory);
    return;
  }
  for (const item of manifest.files ?? []) {
    const destination = path.resolve(root, item.path);
    if (item.existed) copyFileCreatingParents(path.join(directory, item.backup), destination);
    else if (fs.existsSync(destination)) fs.rmSync(destination, { force: true });
  }
  writeJson(path.join(stateRoot(root), "recovery", `${manifest.event_id}.rolled-back.json`), { ...manifest, recovered_at: now(), outcome: "ROLLED_BACK" });
  fs.rmSync(directory, { recursive: true, force: true });
}

function writeJson(location: string, value: any): void {
  atomicWrite(location, `${JSON.stringify(value, null, 2)}\n`);
}

function appendEvent(root: string, event: any): void {
  const location = path.join(stateRoot(root), "events.jsonl");
  const prior = fs.existsSync(location) ? fs.readFileSync(location, "utf8").trimEnd() : "";
  atomicWrite(location, `${prior ? `${prior}\n` : ""}${JSON.stringify(event)}\n`);
}

let pendingOperation: {
  id: string;
  payloadHash: string;
  payloadVersion: number;
  legacyPayloadHash: string;
  legacyKey: string;
  fileInputs: string[];
} | null = null;

/**
 * The version of the algorithm that turns a command line into a payload digest.
 *
 * Version 1 was `sha256(JSON.stringify(flags))` with the operation id removed:
 * the digest of the *text as typed*, in the order it was typed. Two invocations
 * that ask for exactly the same thing produced different digests if the options
 * were written in a different order, or if `--project-root` was spelled `.` the
 * second time — so the retry the contract teaches after an interruption was
 * refused as "different input". And the reverse was worse: a `--content-file`
 * appeared in the digest as its *path*, so the same operation id pointed at the
 * same filename holding entirely different text was accepted as a no-op, and
 * the second content was silently discarded.
 *
 * Version 2 digests what the operation *is*: the command, and its options sorted
 * by name, each tagged with what kind of thing it is. Version 1 is not deleted —
 * it is how every event written before today is recognised, and a project from
 * `alpha.1` or `alpha.2` must keep working.
 */
const OPERATION_INPUT_VERSION = 2;

/**
 * Options whose *content* is the input, not their path.
 *
 * A file passed to one of these is read and digested. Two paths holding
 * identical bytes are therefore the same operation, and the same path holding
 * different bytes is a different one — which is the case that used to pass as a
 * no-op while the new content was thrown away.
 */
const FILE_VALUED_FLAGS = new Set([
  "answer-file", "content-file", "evidence-file", "file", "instruction-file",
  "interpretation-file", "module-answer-file", "next-question-file", "owners-file",
  "question-file", "rationale-file", "reason-file", "reply-file", "source-file",
]);

/** Options that name a place on this filesystem: the location is the input. */
const DIRECTORY_VALUED_FLAGS = new Set(["output-dir", "package-dir"]);

/** Options that name a path *inside the project*, recorded as text in the ledger. */
const RECORDED_PATH_FLAGS = new Set(["base-path"]);

/**
 * One spelling for one location.
 *
 * Separators are forward slashes, a trailing one is dropped, and on Windows the
 * drive letter is upper-cased because `c:\x` and `C:\x` are the same directory
 * there. Nothing else is case-folded: on the systems where case matters, two
 * spellings that differ in case are two different files.
 */
function canonicalPathText(value: string): string {
  let resolved = path.resolve(value).replaceAll("\\", "/");
  if (resolved.length > 1 && resolved.endsWith("/")) resolved = resolved.slice(0, -1);
  if (process.platform === "win32" && /^[a-z]:/.test(resolved)) resolved = resolved[0].toUpperCase() + resolved.slice(1);
  return resolved;
}

/**
 * What this operation was asked to do, in a form that does not depend on typing.
 *
 * Sorted by option name, so order cannot change the digest. Tagged by kind, so a
 * value that happens to look like another kind cannot be confused with it. And
 * deliberately *not* clever about anything else:
 *
 *   - `--project-root` is left out. It says which project the operation belongs
 *     to, and the answer is already "the one whose event log is being read".
 *     Leaving it in meant that running the same command from inside the folder
 *     rather than beside it counted as different input.
 *   - a value that carries a comma-separated list is passed through untouched.
 *     Sorting it would be a guess about whether its order means anything, and
 *     `--sources DEC-1,DEC-2` records provenance in the order given.
 *   - a file that is not there is recorded by its path, marked as missing, so
 *     the digest still distinguishes two different missing files instead of
 *     silently agreeing.
 */
function canonicalOperationInput(command: string, flags: Flags): unknown {
  const options: unknown[] = [];
  for (const key of Object.keys(flags).sort()) {
    if (key === "operation-id" || key === "project-root") continue;
    const value = flags[key];
    if (typeof value === "boolean") {
      options.push([key, "flag", value]);
      continue;
    }
    if (value === undefined) continue;
    const text = String(value);
    if (FILE_VALUED_FLAGS.has(key)) {
      const resolved = path.resolve(text);
      let digest: string | null = null;
      try {
        if (fs.statSync(resolved).isFile()) digest = sha256(fs.readFileSync(resolved));
      } catch { digest = null; }
      options.push(digest ? [key, "file", digest] : [key, "file-missing", canonicalPathText(text)]);
      continue;
    }
    if (DIRECTORY_VALUED_FLAGS.has(key)) {
      options.push([key, "path", canonicalPathText(text)]);
      continue;
    }
    if (RECORDED_PATH_FLAGS.has(key)) {
      options.push([key, "recorded-path", text.replaceAll("\\", "/")]);
      continue;
    }
    options.push([key, "value", text]);
  }
  return { algorithm: OPERATION_INPUT_VERSION, command, options };
}

function idempotencyKey(flags: Flags): string {
  const operationId = required(flags, "operation-id").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(operationId)) throw new PlangonautError(`Invalid --operation-id; use 3-128 letters, numbers, '.', '_', ':' or '-'`);
  // Both digests are computed, every time. The new one is what a new event
  // records; the old one is the only way to recognise an event written before
  // today, and recognising those is not optional — an unrecognised completed
  // operation is one that gets applied twice.
  const legacyFlags = { ...flags };
  delete legacyFlags["operation-id"];
  const legacyPayloadHash = sha256(JSON.stringify(legacyFlags));
  const payloadHash = sha256(canonicalJson(canonicalOperationInput(runningCommand, flags)));
  pendingOperation = {
    id: operationId,
    payloadHash,
    payloadVersion: OPERATION_INPUT_VERSION,
    legacyPayloadHash,
    legacyKey: sha256(`${operationId}:${legacyPayloadHash}`),
    // Which of this command's options are files. It decides whether a
    // version-1 record can be trusted to say "this is the same operation":
    // that digest saw the path and never the content.
    fileInputs: Object.keys(flags).filter((key) => FILE_VALUED_FLAGS.has(key)).sort(),
  };
  return sha256(`${operationId}:${payloadHash}`);
}

/**
 * Has this operation already happened?
 *
 * The answer is read from the event history, so an operation that was
 * interrupted *after* its event was appended and before its state was written
 * used to answer "yes" over a project that had not caught up — the command
 * reported `Idempotent retry` and exit 0 while `replay` reported the state as
 * diverged. The mirror case was as bad: interrupted before the append, the retry
 * answered "no", `loadState` then completed the original operation underneath
 * it, and the command failed on its own now-unsatisfiable preconditions.
 *
 * One line fixes both, and it is the line that says what the order means:
 * finish what was interrupted, *then* ask whether this is a repeat. Found by an
 * independent review on 2026-09-12, in seventeen commands at once.
 */
function checkIdempotency(root: string, key: string): boolean {
  const eventsPath = path.join(stateRoot(root), "events.jsonl");
  if (!fs.existsSync(eventsPath)) return false;
  recoverFileTransactions(root);
  const lines = fs.readFileSync(eventsPath, "utf8").split(/\r?\n/).filter(Boolean);
  return lines.some((line) => {
    let event: any;
    try { event = JSON.parse(line); } catch { return false; }
    /*
     * The same operation id, different input.
     *
     * The refusal is right — an operation id names one operation, and letting a
     * second one borrow it would make the idempotency record meaningless. What
     * was wrong is that it said nothing about the situation a user is usually in
     * when they see it: the second review reached it by following the documented
     * recovery route after an interrupted `doc-save` (a fresh `doc-diff`, then
     * `doc-save` with the same id), where the input differs precisely because
     * the first attempt already succeeded. Exit 2 and nothing written was
     * correct; "was already used with different input" was not enough to act on.
     */
    /*
     * Compared with the algorithm the record itself declares.
     *
     * An event with no `operation_payload_version` was written by version 1 and
     * is judged by version 1: its digest is over the text as typed, and this
     * engine cannot recompute a version-2 digest for input it never saw. So a
     * reordered retry of an operation recorded by an older engine still
     * conflicts — correctly, because nothing here can prove the two are the
     * same. From today's records on, order does not matter.
     */
    const recordedVersion = Number(event.operation_payload_version ?? 1);
    const mine = pendingOperation
      ? recordedVersion >= OPERATION_INPUT_VERSION
        ? pendingOperation.payloadHash
        : pendingOperation.legacyPayloadHash
      : null;
    if (pendingOperation && event.operation_id === pendingOperation.id && event.operation_payload_hash !== mine) {
      throw new PlangonautError(
        `Operation ID ${pendingOperation.id} was already used with different input: it recorded ${event.type ?? "an event"} at revision ${event.state_revision ?? "?"}, ${event.at ?? "an earlier instant"}. No changes written.
` +
          `If you are retrying an interrupted operation, it already finished - \`plangonaut status --project-root .\` shows it, and repeating it is not needed. ` +
          `If this is new work, give it a new operation id.`,
      );
    }
    // Either generation of the key identifies the same completed operation. A
    // record this engine cannot recognise is one it would apply a second time.
    const matches = event.idempotency_key === key || (pendingOperation !== null && event.idempotency_key === pendingOperation.legacyKey);
    /*
     * A version-1 record cannot certify a file-valued operation as a repeat.
     *
     * Version 1 digested the *path* of a `--*-file` option and never its
     * content, so the same id, the same filename and entirely different text
     * produced the same digest — and the engine answered `Idempotent retry`
     * while the new content was discarded. Version 2 fixed that for records it
     * writes; it could not fix it for records written before today, because a
     * version-2 digest cannot be recomputed for input no engine ever saw. A
     * fourth independent review demonstrated it end to end with the shipped
     * `alpha.2` tarball: a human override reading "do NOT ship" was thrown away
     * over one reading "ship on Friday", exit 0.
     *
     * So the answer here is neither "yes" nor a silent "no". It is a refusal
     * that says why, changes nothing, and leaves the decision with a person —
     * the conservative direction, because the alternative discards their work.
     */
    if (matches && pendingOperation && Number(event.operation_payload_version ?? 1) < OPERATION_INPUT_VERSION && pendingOperation.fileInputs.length) {
      throw new PlangonautError(
        `Operation ID ${pendingOperation.id} was recorded by an earlier version of Plangonaut, and this command reads ${pendingOperation.fileInputs.map((key) => `--${key}`).join(", ")}.\n` +
          `That older record digested the *path* of a file and not its content, so Plangonaut cannot tell whether this is the same operation or the same filename holding something new — and answering "already applied" would throw away whatever the file says now. Nothing was written.\n` +
          `If the earlier operation completed, there is nothing to do: \`plangonaut status --project-root .\` and \`plangonaut validate --project-root .\` show the recorded result. If this is new input, give it a new operation id.`,
      );
    }
    return matches;
  });
}

function assertNotBlocked(state: State): void {
  if (state.needs_reconciliation) {
    throw new PlangonautError("State is BLOCKED pending human reconciliation. Resolve open overrides before continuing.");
  }
}

/**
 * The sentence a divergent project gets, once, with the way out.
 *
 * It is not a repair and not a refusal to work forever: it says which two things
 * disagree and which command reconciles them.
 */
function divergenceRefusal(): string {
  return (
    "The state on disk does not match the history that produced it: its digest is not the one the last event recorded. " +
    "Something rewrote .beave/state.json outside Plangonaut. Nothing was written. " +
    "Run `plangonaut replay --project-root . --verify` to see exactly which fields differ, then either restore the file or rebuild it with `plangonaut replay --project-root . --repair --operation-id <id>`."
  );
}

/**
 * The one place a project's durable state changes.
 *
 * It validates, then records the mutation itself — not a digest of it — and
 * proves, before writing a byte, that the recorded mutation reproduces the state
 * it describes. Then it writes through the journal: event first, state second,
 * because the event is the point at which the operation has happened.
 */
function commitState(root: string, location: string, state: State, event: any, options: { views?: boolean; origin?: boolean } = {}): void {
  if (pendingOperation && event.idempotency_key) {
    Object.assign(event, {
      operation_id: pendingOperation.id,
      operation_payload_hash: pendingOperation.payloadHash,
      // Declared, not inferred: a digest whose algorithm is a guess is a digest
      // that stops matching the day the algorithm changes again.
      operation_payload_version: pendingOperation.payloadVersion,
    });
  }
  /*
   * Which engine last wrote to this project.
   *
   * `beave_version` is set by `init`, `migrate` and `baseline` and by nothing
   * else, so it answers "what created this" and was read for two turns as "what
   * version this project is on". Those are different facts, and the difference
   * cost a misattribution: a pilot run with `0.3.0-alpha.3` on the PATH produced
   * a state saying `0.3.0-alpha.3`, and the review of it was filed under
   * `alpha4` because nothing anywhere said which engine had actually been doing
   * the work.
   *
   * Set here rather than in each command, because here is the one place every
   * mutation passes through. It rides the state patch like every other field, so
   * replay reproduces it and no event format changes.
   */
  state.last_engine_version = VERSION;

  const errors = stateErrors(root, state, event);
  if (errors.length) {
    throw new PlangonautError(`Transaction failed validation:\n- ${errors.join("\n- ")}`);
  }

  const before = fs.existsSync(location) ? readJson(location) : null;
  const tail = lastEventLine(root);

  /*
   * Not onto a history that cannot be replayed.
   *
   * The digest check below only fires when the last event recorded one, so a
   * foreign event with no digests let every later write straight through — and
   * that is how the pilot accumulated a run of perfectly good events sitting on
   * top of one nobody could apply. Each of those writes was individually
   * correct and each one made the problem larger.
   *
   * `baseline` is the exception and has to be: drawing a new starting point
   * over an unreplayable history is the whole of what it does. It says so with
   * `replay_origin`, which nothing else sets.
   */
  if (event.replay_origin !== true && before !== null) {
    /*
     * Damage, not age.
     *
     * `historyErrors` already draws this line and draws it in one place: a
     * history with no replay origin, or none at all, is a project written
     * before the format and is not an error. A broken chain, a duplicated
     * event, an event with no applicable mutation - those are. Re-deriving the
     * distinction here would have been a second opinion about the same
     * question, and the first version of this guard did exactly that and
     * refused every legacy project a write.
     */
    /*
     * And only for damage to the history itself.
     *
     * A state that has been hand-edited is also an error here, and it already
     * has a refusal of its own a few lines below that names the fields that
     * differ. Firing first replaced a precise message with a general one, which
     * is a worse answer to the same question.
     */
    const outcome = replayFromEvents(root);
    const history = outcome.replayable ? { errors: [] as string[] } : historyErrors(root, before as State);
    if (history.errors.length) {
      throw new PlangonautError(
        `This project's history cannot be replayed, so nothing may be written on top of it:\n  ${history.errors.join("\n  ")}\n\n` +
        `A new event here would be a verifiable record appended to an unverifiable one, which is how a small break becomes a large one.\n` +
        `plangonaut replay --verify --project-root . prints the full diagnosis and the one safe way forward. Nothing was written.`,
        "PROJECT_STATE_UNTRUSTED",
      );
    }
  }
  // A state edited by hand is not overwritten in silence. Only checkable where
  // the previous event recorded a digest: a project whose history predates this
  // format carries none, and no check is invented for it.
  if (tail?.event?.state_sha256 && digestOf(before) !== tail.event.state_sha256) {
    throw new PlangonautError(divergenceRefusal());
  }

  const patch: PatchOp[] = [];
  if (options.origin === true) patch.push({ op: "set", path: [], value: structuredClone(state) });
  else diffValue(before, state, [], patch);
  const stateAfter = digestOf(state);
  const rebuilt = digestOf(applyPatch(before, patch));
  if (rebuilt !== stateAfter) {
    throw new PlangonautError("Internal: the mutation this event would record does not reproduce the state it describes. Nothing was written. This is a defect in the engine, not in the project.");
  }

  Object.assign(event, {
    format: EVENT_FORMAT,
    previous_revision: before ? Number(before.revision ?? 0) : 0,
    previous_state_sha256: before ? digestOf(before) : null,
    state_sha256: stateAfter,
    state_patch: patch,
    previous_event_sha256: tail ? sha256(tail.line) : null,
  });
  if (event.replay_origin !== true) delete event.replay_origin;
  event.payload_sha256 = digestOf({ ...event, payload_sha256: undefined });

  const owned = activeTransaction === null;
  const directory = owned ? beginFileTransaction(root, event, []) : activeTransaction!.directory;
  const handle: TransactionHandle = { directory, root };

  const eventLine = JSON.stringify(event);
  const stateContent = `${JSON.stringify(state, null, 2)}\n`;
  const eventsLocation = path.join(stateRoot(root), "events.jsonl");
  atomicWrite(path.join(directory, "staged-state.json"), stateContent);
  const journal = readJson(journalPath(directory));
  journal.staged = {
    event_line: eventLine,
    events_prior_bytes: fs.existsSync(eventsLocation) ? fs.statSync(eventsLocation).size : 0,
    state_sha256_file: sha256(stateContent),
    regenerate_views: options.views === true,
  };
  journal.phase = "COMMITTING" satisfies TransactionPhase;
  writeJournal(directory, journal);
  faultPoint("after-staged");
  faultPoint("before-commit");

  appendEvent(root, event);
  faultPoint("after-events");
  writeJson(location, state);
  faultPoint("after-state");
  setPhase(handle, "COMMITTED");
  faultPoint("after-commit");
  if (owned) completeFileTransaction(directory);
}

// ---------------------------------------------------------------------------
// The reducer
//
// Deterministic by construction: it reads `events.jsonl` and nothing else. No
// clock, no filesystem beyond that one file, no field copied across from
// `state.json` — which is the failure mode the brief names, and the reason the
// result is compared digest for digest at every single step rather than only at
// the end. An event whose patch does not reproduce the digest it recorded stops
// the replay where it is and says which revision failed.
// ---------------------------------------------------------------------------

interface ReplayOutcome {
  replayable: boolean;
  /** Why not, when it is not. Always a sentence with a way forward in it. */
  reason: string | null;
  state: any;
  originIndex: number;
  originType: string | null;
  applied: number;
  throughRevision: number | null;
  /** Events before the origin: present in the file, outside what replay proves. */
  unprovenBefore: number;
}

function replayFromEvents(root: string): ReplayOutcome {
  const empty: ReplayOutcome = { replayable: false, reason: null, state: null, originIndex: -1, originType: null, applied: 0, throughRevision: null, unprovenBefore: 0 };
  const lines = eventLines(root);
  if (!lines.length) return { ...empty, reason: "This project has no event history to replay." };

  const malformed = lines.findIndex((item) => item.malformed);
  if (malformed >= 0) {
    return { ...empty, reason: `Line ${malformed + 1} of .beave/events.jsonl is not valid JSON, so the history cannot be read past it. Nothing was changed.` };
  }

  // The chain, checked over the whole file rather than only over the replayed
  // part: it is the tamper-evidence, and it is worth as much before the origin
  // as after it.
  const seen = new Set<string>();
  for (let index = 0; index < lines.length; index += 1) {
    const event = lines[index].event;
    if (typeof event.event_id === "string") {
      if (seen.has(event.event_id)) return { ...empty, reason: `Event ${event.event_id} appears twice in .beave/events.jsonl (line ${index + 1}). A history with a duplicated event cannot be replayed.` };
      seen.add(event.event_id);
    }
    if (typeof event.format !== "number") continue;
    if (event.format > EVENT_FORMAT) {
      return { ...empty, reason: `Line ${index + 1} was written in event format ${event.format}; this engine reads up to ${EVENT_FORMAT}. Upgrade Plangonaut rather than replaying it with an older reader.` };
    }
    const expected = index === 0 ? null : sha256(lines[index - 1].line);
    if ((event.previous_event_sha256 ?? null) !== expected) {
      return { ...empty, reason: `The event chain breaks at line ${index + 1} (${event.type}): it records a different predecessor than the line before it. The history was edited outside Plangonaut.` };
    }
    /*
     * The event's own digest, checked rather than merely stored.
     *
     * It was written on every event and read by nothing, which an independent
     * review demonstrated the cost of: editing an event's metadata — an owner,
     * a reason — and recomputing only the chain produced a history that
     * verified. The detector was already in the file and was not being used.
     */
    if (typeof event.payload_sha256 === "string") {
      const recomputed = digestOf({ ...event, payload_sha256: undefined });
      if (recomputed !== event.payload_sha256) {
        return { ...empty, reason: `Line ${index + 1} (${event.type}) does not match the digest it records of itself. The event was edited after it was written.` };
      }
    }
  }

  let originIndex = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const event = lines[index].event;
    if (typeof event.format === "number" && event.replay_origin === true) {
      originIndex = index;
      break;
    }
  }
  if (originIndex < 0) {
    return {
      ...empty,
      reason:
        "This project's history has no point the state can be rebuilt from. Its events were written by an engine that recorded digests of each change rather than the change itself, so they cannot be replayed and nothing will be invented for them. " +
        "Record a starting point with `plangonaut baseline --project-root . --reason \"<why>\" --owner <name> --operation-id <id>`: everything from there on is reproducible, and everything before it stays in the file, unproven and marked as such.",
    };
  }

  let state: any = null;
  let applied = 0;
  for (let index = originIndex; index < lines.length; index += 1) {
    const event = lines[index].event;
    const where = `line ${index + 1} (${event.type ?? "no type"}, revision ${event.state_revision ?? "?"})`;
    if (typeof event.format !== "number") {
      return { ...empty, originIndex, originType: lines[originIndex].event.type, reason: `The history after the replay origin is not uniform: ${where} carries no event format, so it records no mutation to apply.` };
    }
    if (index > originIndex) {
      const expectedPrevious = digestOf(state);
      if (event.previous_state_sha256 !== expectedPrevious) {
        return { ...empty, originIndex, originType: lines[originIndex].event.type, reason: `At ${where} the recorded previous state does not match the state rebuilt so far. The history is not continuous here.` };
      }
      if (Number(event.previous_revision) !== Number(state?.revision ?? 0)) {
        return { ...empty, originIndex, originType: lines[originIndex].event.type, reason: `At ${where} the recorded previous revision is ${event.previous_revision}, but the state rebuilt so far is at revision ${state?.revision ?? 0}. Events are out of order or one is missing.` };
      }
      /*
       * A revision that does not advance.
       *
       * Every command builds revision N+1 from the N it read, so an event whose
       * revision equals its predecessor's is not a history this engine wrote.
       * That is precisely the shape a lost update leaves: two processes read
       * revision N, the second commits against what it finds on disk, and the
       * chain stays continuous while the first process's work is overwritten
       * inside the patch. Everything else here — digests, chain, patch — passes
       * on such a file, and `validate` was the only command that caught it. It
       * is caught here now, and `tests/project-lock.test.mjs` builds the
       * counter-example by removing the lock rather than describing it.
       */
      if (Number(event.state_revision) !== Number(event.previous_revision) + 1) {
        return { ...empty, originIndex, originType: lines[originIndex].event.type, reason: `At ${where} the revision does not advance: the event follows revision ${event.previous_revision} and records revision ${event.state_revision}. Two events cannot occupy one revision, and a write that overwrote another's is the usual cause.` };
      }
    }
    try {
      state = applyPatch(state, event.state_patch);
    } catch (error: any) {
      return { ...empty, originIndex, originType: lines[originIndex].event.type, reason: `${where} could not be applied: ${error.message}` };
    }
    const produced = digestOf(state);
    if (produced !== event.state_sha256) {
      return { ...empty, originIndex, originType: lines[originIndex].event.type, reason: `${where} does not produce the state it recorded: rebuilding it gives ${produced.slice(0, 12)}… where the event claims ${String(event.state_sha256).slice(0, 12)}…. The event was altered after it was written.` };
    }
    if (Number(state?.revision) !== Number(event.state_revision)) {
      return { ...empty, originIndex, originType: lines[originIndex].event.type, reason: `${where} rebuilds a state at revision ${state?.revision}, which is not the revision the event records.` };
    }
    applied += 1;
  }

  return {
    replayable: true,
    reason: null,
    state,
    originIndex,
    originType: lines[originIndex].event.type,
    applied,
    throughRevision: Number(state?.revision ?? 0),
    unprovenBefore: originIndex,
  };
}

/** Field-by-field, in the words of the paths that differ. */
function describeDifferences(current: unknown, rebuilt: unknown, limit = 40): string[] {
  const ops: PatchOp[] = [];
  diffValue(current, rebuilt, [], ops);
  const lines = ops.slice(0, limit).map((op) => {
    const at = op.path.length ? op.path.join(".") : "<the whole state>";
    if (op.op === "del") return `  ${at}: present on disk, absent in the rebuilt state`;
    if (op.op === "trim") return `  ${at}: the rebuilt state holds ${op.value} entries, the file holds more`;
    const value = canonicalJson(op.value);
    return `  ${at}: rebuilt as ${value.length > 120 ? `${value.slice(0, 117)}…` : value}`;
  });
  if (ops.length > limit) lines.push(`  … and ${ops.length - limit} more`);
  return lines;
}

/**
 * What is wrong with this history, in enough detail to act on.
 *
 * `replayFromEvents` answers "can this be rebuilt" and returns one sentence.
 * That sentence was correct and was not enough: the pilot's project failed on
 * *«the history after the replay origin is not uniform»*, and a person reading
 * it could not tell which event, written by what, missing which fields, with
 * how much history after it, or what was safe to do next.
 *
 * So the sentence stays and this stands behind it. Every reader — `replay
 * --verify`, `validate`, `status`, `handoff-check` — uses this one function, so
 * four commands cannot describe the same damage four ways.
 */
interface IntegrityDiagnosis {
  sound: boolean;
  /** `null` when sound. */
  defect: {
    /** 1-based, as an editor counts. */
    line: number;
    event_id: string | null;
    type: string | null;
    /** The format the event declares, or 1 when it declares none. */
    detected_format: number;
    /** Fields its declared format requires and it does not carry. */
    missing_fields: string[];
    /** What the engine can say about the value now. */
    current_value: string;
    /** What could be rebuilt, when anything could. */
    reconstructible_value: string | null;
    /** The last line the chain and the digests verify. */
    last_verifiable_line: number | null;
    /** How many events come after the defect. */
    events_after: number;
    /** What kind of damage this is. */
    category: string;
    /** Which engines are implicated. */
    versions: string;
    /** The one safe way forward. */
    remedy: string[];
    /** What must not be done, and why. */
    forbidden: string[];
  } | null;
}

function integrityDiagnosis(root: string): IntegrityDiagnosis {
  const outcome = replayFromEvents(root);
  if (outcome.replayable) {
    const location = path.join(stateRoot(root), "state.json");
    const current = fs.existsSync(location) ? readJson(location) : null;
    if (current !== null && digestOf(outcome.state) !== digestOf(current)) {
      const lines = eventLines(root);
      return {
        sound: false,
        defect: {
          line: lines.length,
          event_id: lines.length ? (lines[lines.length - 1].event?.event_id ?? null) : null,
          type: lines.length ? (lines[lines.length - 1].event?.type ?? null) : null,
          detected_format: EVENT_FORMAT,
          missing_fields: [],
          current_value: `state.json is at revision ${current?.revision ?? "?"}, digest ${digestOf(current).slice(0, 12)}…`,
          reconstructible_value: `the history rebuilds revision ${outcome.throughRevision}, digest ${digestOf(outcome.state).slice(0, 12)}…`,
          last_verifiable_line: lines.length,
          events_after: 0,
          category: "state does not match its own history",
          versions: `project last written by ${String(current?.last_engine_version ?? "an engine that recorded none")}; this engine is ${VERSION}`,
          remedy: [
            `plangonaut replay --project-root . --repair --operation-id <id> rebuilds the state from the events and keeps a backup of what it replaces.`,
          ],
          forbidden: [
            `Editing state.json by hand. The next command would find a state that does not match its history and refuse again, and the backup would be of the edited file.`,
          ],
        },
      };
    }
    return { sound: true, defect: null };
  }

  const lines = eventLines(root);
  /*
   * Where it actually goes wrong.
   *
   * The reason string carries a line number and parsing it back out would be
   * building a second source of truth out of a sentence. The line is found the
   * same way `replayFromEvents` found it instead: the first event after the
   * replay origin that cannot record a mutation.
   */
  let badIndex = -1;
  const origin = outcome.originIndex >= 0 ? outcome.originIndex : 0;
  for (let index = origin; index < lines.length; index += 1) {
    const event = lines[index].event;
    if (lines[index].malformed) { badIndex = index; break; }
    if (typeof event?.format !== "number") { badIndex = index; break; }
    const missing = FORMAT_2_REQUIRED.filter((field) => event?.[field] === undefined);
    if (event.format >= 2 && missing.length) { badIndex = index; break; }
  }

  if (badIndex < 0) {
    // Replay failed for a reason that is not a single bad line: no origin, an
    // empty history, a duplicated id. Reported as itself rather than pinned on
    // a line the engine had to guess.
    return {
      sound: false,
      defect: {
        line: 0,
        event_id: null,
        type: null,
        detected_format: 0,
        missing_fields: [],
        current_value: outcome.reason ?? "the history cannot be replayed",
        reconstructible_value: null,
        last_verifiable_line: null,
        events_after: lines.length,
        category: "history cannot be replayed",
        versions: `this engine is ${VERSION}`,
        remedy: [`plangonaut replay --verify --project-root . prints the whole comparison.`],
        forbidden: [],
      },
    };
  }

  const event = lines[badIndex].event ?? {};
  const declared = typeof event.format === "number" ? event.format : 1;
  const missing = declared >= 2
    ? FORMAT_2_REQUIRED.filter((field) => event[field] === undefined)
    : FORMAT_2_REQUIRED.filter((field) => event[field] === undefined);
  const after = lines.length - badIndex - 1;

  return {
    sound: false,
    defect: {
      line: badIndex + 1,
      event_id: typeof event.event_id === "string" ? event.event_id : null,
      type: typeof event.type === "string" ? event.type : null,
      detected_format: declared,
      missing_fields: missing,
      current_value: `the event records ${Object.keys(event).length} fields and no mutation this engine can apply`,
      /*
       * Honest about what cannot be rebuilt.
       *
       * The event says what changed in prose — an artifact id, a revision, a
       * hash — and not how the state changed. A patch could be *guessed* from
       * the state as it stands, and a guessed mutation presented as a recorded
       * one is the failure this whole mechanism exists to prevent.
       */
      reconstructible_value: null,
      last_verifiable_line: badIndex > 0 ? badIndex : null,
      events_after: after,
      category: declared < 2
        ? "an event written in an older format, inside a history that had moved on"
        : "an event declaring a format whose required fields it does not carry",
      versions:
        `the event was written by a writer producing event format ${declared}; this history is at format ${EVENT_FORMAT} and this engine reads ${READABLE_EVENT_FORMATS.join(", ")}`,
      remedy: [
        `plangonaut baseline --project-root . --dry-run --reason "<why>" --owner <name> shows what a new starting point would prove and what it would leave outside the proof.`,
        `Run it without --dry-run to record one. Everything from the baseline forward is reproducible; everything before it stays in the file, readable and explicitly unproven.`,
        after > 0
          ? `The ${after} event${after === 1 ? "" : "s"} after line ${badIndex + 1} ${after === 1 ? "is" : "are"} intact and ${after === 1 ? "is" : "are"} carried across a baseline.`
          : `Nothing follows the defect, so a baseline loses no later work.`,
      ],
      forbidden: [
        `plangonaut replay --repair. It rebuilds the state from what it can apply, and it cannot apply this line — the result would silently omit this event and the ${after} after it. The command refuses for that reason and must not be forced.`,
        `Deleting or rewriting the event. The digest chain covers it; removing a line breaks every event after it, and editing one makes the history say something nobody recorded.`,
        `Accepting it as a decision. An integrity failure is not a priority call: see the refusal in \`decisionsCannotWaiveIntegrity\`.`,
      ],
    },
  };
}

/**
 * A human decision can change what a project does. It cannot change what happened.
 *
 * The distinction this engine has to hold, and the one the pilot's folder tried
 * to blur: an owner may decide that a risk is accepted, that a requirement is
 * dropped, that a deadline matters more than a feature. None of those is a
 * statement about whether the recorded history reproduces the recorded state.
 *
 * So there is no flag, no override and no decision status that turns a broken
 * chain into a sound one, and this function exists to be the single place that
 * says so — quoted verbatim wherever somebody is likely to look for the flag.
 */
function decisionsCannotWaiveIntegrity(): string[] {
  return [
    `An integrity failure is not a matter of priority and cannot be accepted, deferred or overridden.`,
    `A decision can change what this project builds and in what order. It cannot make an unreproducible history reproducible,`,
    `an event without an applicable mutation applicable, a broken digest chain whole, or an unrecorded change recorded.`,
    `This engine has no flag for it, on purpose. Execution readiness and handoff readiness both fail while it stands.`,
  ];
}

/** The lines every command prints about a damaged history, in the same words. */
function integrityLines(diagnosis: IntegrityDiagnosis): string[] {
  if (diagnosis.sound || !diagnosis.defect) return [];
  const defect = diagnosis.defect;
  const lines = [
    `Mechanical integrity: FAILED (${defect.category}).`,
    ``,
  ];
  if (defect.line > 0) {
    lines.push(
      `  event line              ${defect.line}`,
      `  event id                ${defect.event_id ?? "not recorded"}`,
      `  type                    ${defect.type ?? "not recorded"}`,
      `  detected event format   ${defect.detected_format}`,
      `  missing required fields ${defect.missing_fields.length ? defect.missing_fields.join(", ") : "none"}`,
      `  current value           ${defect.current_value}`,
      `  reconstructible value   ${defect.reconstructible_value ?? "none — the event records no mutation, and a guessed one would be an invention"}`,
      `  last verifiable event   ${defect.last_verifiable_line === null ? "none" : `line ${defect.last_verifiable_line}`}`,
      `  events after it         ${defect.events_after}`,
      `  versions                ${defect.versions}`,
      ``,
    );
  }
  lines.push(`Safe remedy:`);
  for (const line of defect.remedy) lines.push(`- ${line}`);
  if (defect.forbidden.length) {
    lines.push(``, `Do not:`);
    for (const line of defect.forbidden) lines.push(`- ${line}`);
  }
  lines.push(``, ...decisionsCannotWaiveIntegrity());
  return lines;
}

/** The sentence Resume, validate and replay all print, so they cannot disagree. */
function replaySummary(root: string, outcome: ReplayOutcome, current: any): { ok: boolean; lines: string[] } {
  const lines: string[] = [];
  if (!outcome.replayable) {
    lines.push(`History replay: NOT REPRODUCIBLE. ${outcome.reason}`);
    return { ok: false, lines };
  }
  const rebuilt = digestOf(outcome.state);
  const live = digestOf(current);
  if (rebuilt === live) {
    lines.push(`History replay: the state matches its history exactly (${outcome.applied} event${outcome.applied === 1 ? "" : "s"} from ${outcome.originType}, through revision ${outcome.throughRevision}).`);
    if (outcome.unprovenBefore > 0) {
      lines.push(outcome.unprovenBefore === 1
        ? `  1 earlier event is kept in the file and is not covered by this proof: it predates the replay origin.`
        : `  ${outcome.unprovenBefore} earlier events are kept in the file and are not covered by this proof: they predate the replay origin.`);
    }
    return { ok: true, lines };
  }
  lines.push("History replay: DIVERGED. The state on disk is not what its own events produce.");
  lines.push(...describeDifferences(current, outcome.state));
  lines.push("Repair it with: plangonaut replay --project-root . --repair --operation-id <id>");
  return { ok: false, lines };
}

function replay(flags: Flags): void {
  const root = resolveProject(required(flags, "project-root"));
  const repair = flags.repair === true;
  // `--verify` is the default, so it is accepted and means what it says. Asking
  // for both is a caller who has not decided which one they want, and an option
  // this engine accepts and ignores is the defect it refuses everywhere else.
  if (repair && flags.verify === true) {
    throw new PlangonautError("--verify and --repair ask for different things: one reads and reports, the other writes. Choose one. Nothing was changed.");
  }
  if (!repair) {
    // Verification changes nothing, so it does not run recovery either: a
    // command that reports the state must not be the command that alters it.
    const location = path.join(stateRoot(root), "state.json");
    if (!fs.existsSync(location)) {
      // The command the contract recommends for diagnosing a project must say
      // something useful about the one shape of damage it exists to repair.
      throw new PlangonautError(
        fs.existsSync(path.join(stateRoot(root), "events.jsonl"))
          ? `.beave/state.json is missing, and the event history is still here. Rebuild the state from it:\n  plangonaut replay --project-root . --repair --operation-id <id>\nNothing was changed.`
          : `No Plangonaut state at ${stateRoot(root)}`,
      );
    }
    const current = readJson(location);
    /*
     * Verification does not recover -- a command that reports must not be the
     * command that alters -- so it says what is outstanding instead of reporting
     * a recoverable project as a damaged one.
     */
    const pending = pendingTransactions(root);
    if (pending.length) {
      console.log(`${pending.length} operation${pending.length === 1 ? " was" : "s were"} interrupted and ${pending.length === 1 ? "is" : "are"} waiting to be resolved: ${pending.map((item) => `${item.journal.event_type ?? "operation"} (${item.journal.phase})`).join(", ")}.`);
      console.log(`Any command that touches this project resolves them, or run \`plangonaut recover --project-root . --apply\`. Until then the comparison below describes a project that is mid-operation.`);
    }
    const outcome = replayFromEvents(root);
    const summary = replaySummary(root, outcome, current);
    for (const line of summary.lines) console.log(line);
    if (!summary.ok) {
      // The sentence above says what failed; this says enough to act on it.
      const diagnosis = integrityDiagnosis(root);
      const detail = integrityLines(diagnosis);
      if (detail.length) console.log(`\n${detail.join("\n")}`);
      throw new PlangonautError("The project state cannot be verified against its history.");
    }
    return;
  }

  const key = idempotencyKey(flags);
  recoverFileTransactions(root);
  const location = path.join(stateRoot(root), "state.json");
  /*
   * A missing state file is the case this command exists for.
   *
   * It used to go through `loadState`, which reads `state.json` — so the one
   * situation in which rebuilding from the history would actually save a project
   * was the one situation the command could not handle. It died on a raw ENOENT.
   * An independent review found it by deleting the file and asking for a repair.
   */
  const current = fs.existsSync(location) ? (readJson(location) as State) : null;
  if (checkIdempotency(root, key)) return console.log(`Idempotent retry: this repair is already recorded.`);
  const outcome = replayFromEvents(root);
  if (!outcome.replayable) {
    /*
     * A repair that omits events is not a repair.
     *
     * The dangerous shape is an event this engine cannot apply followed by
     * events it can: rebuilding "what is applicable" produces a state that is
     * internally consistent, verifies cleanly, and quietly does not contain the
     * work those events recorded. The command refuses, and says how much would
     * have gone, because "nothing can be rebuilt" alone reads like a dead end
     * rather than like a choice between two roads.
     */
    const diagnosis = integrityDiagnosis(root);
    const after = diagnosis.defect?.events_after ?? 0;
    throw new PlangonautError(
      `Nothing can be rebuilt: ${outcome.reason}\n\n` +
      (diagnosis.defect && diagnosis.defect.line > 0
        ? `Rebuilding only what is applicable would drop event line ${diagnosis.defect.line} and the ${after} event${after === 1 ? "" : "s"} after it, ` +
          `and would produce a state that verifies cleanly while missing what they recorded. This command will not do that.\n\n` +
          `The road that does not lose them:\n` +
          `  plangonaut baseline --project-root . --dry-run --reason "<why>" --owner <name>\n` +
          `It records a new starting point, carries the later events across it, keeps the earlier ones in the file marked unproven, and states the boundary of the proof.\n`
        : ``) +
      `Nothing was changed.`,
      "PROJECT_STATE_UNTRUSTED",
    );
  }
  if (current !== null && digestOf(outcome.state) === digestOf(current)) {
    return console.log("Nothing to repair: the state already matches its history exactly.");
  }

  const at = now();
  const eventId = crypto.randomUUID();
  const rebuilt = structuredClone(outcome.state);
  const differences = current === null
    ? [`  .beave/state.json was missing and has been rebuilt from ${outcome.applied} recorded event${outcome.applied === 1 ? "" : "s"}.`]
    : describeDifferences(current, outcome.state);

  /*
   * Backups first, and of both files.
   *
   * What this command replaces is a state somebody may have edited on purpose.
   * The bytes it overwrites are preserved under `.beave/backups/` before a single
   * write, so "repair" never means "discard what was there".
   */
  const backupState = current === null ? null : backupName(location);
  if (backupState) {
    fs.mkdirSync(path.dirname(backupState), { recursive: true });
    fs.copyFileSync(location, backupState);
  }
  const eventsLocation = path.join(stateRoot(root), "events.jsonl");
  const backupEvents = backupName(eventsLocation);
  fs.mkdirSync(path.dirname(backupEvents), { recursive: true });
  fs.copyFileSync(eventsLocation, backupEvents);

  const event: any = {
    event_id: eventId,
    type: "STATE_REPAIRED_FROM_EVENTS",
    state_revision: Number(rebuilt.revision) + 1,
    at,
    idempotency_key: key,
    rebuilt_from: outcome.originType,
    events_applied: outcome.applied,
    replaced_state_sha256: current === null ? null : digestOf(current),
    rebuilt_state_sha256: digestOf(rebuilt),
    differences: differences.length,
    state_backup: backupState === null ? null : path.relative(root, backupState).replaceAll("\\", "/"),
    events_backup: path.relative(root, backupEvents).replaceAll("\\", "/"),
  };

  const transaction = beginFileTransaction(root, event, [path.join(root, QA_VIEW_RELATIVE)]);
  try {
    // The rebuilt state is put back first, so the event that records the repair
    // is written on top of a state that already agrees with its own history.
    // Recording it the other way round would put the divergent digest into the
    // chain and make the next replay fail on this very event.
    atomicWrite(location, `${JSON.stringify(rebuilt, null, 2)}\n`);
    const repaired = structuredClone(rebuilt);
    repaired.revision = event.state_revision;
    repaired.last_event_id = eventId;
    repaired.updated_at = at;
    if (repaired.interview_view) repaired.interview_view = { path: QA_VIEW_RELATIVE, sha256: sha256(renderInterviewView(repaired)) };
    commitState(root, location, repaired, event, { views: true });
    if (Array.isArray(repaired.interview_log)) writeInterviewView(root, renderInterviewView(repaired));
    faultPoint("after-view");
    completeFileTransaction(transaction);
  } catch (error) {
    if (fs.existsSync(transaction)) rollbackFileTransaction(root, transaction);
    throw error;
  }

  console.log(`Rebuilt the state from ${outcome.applied} recorded event${outcome.applied === 1 ? "" : "s"}.`);
  if (event.state_backup) console.log(`What the file said before is preserved at ${event.state_backup}.`);
  else console.log(`There was no state file to preserve: it was missing, and the history is where this came from.`);
  for (const line of differences) console.log(line);
  console.log(`Recorded as ${eventId}. Run \`plangonaut validate --project-root .\` to confirm.`);
}

/**
 * A verifiable starting point for a project whose earlier events cannot be replayed.
 *
 * It records the current state in full, with a digest, a reason and an instant.
 * It does not delete, rewrite or reinterpret anything before it: those events
 * stay in the file and stay outside what replay proves, which is the honest
 * description of a history that was written without the information.
 */
function baseline(flags: Flags): void {
  const root = resolveProject(required(flags, "project-root"));
  /*
   * Who held the project before this command did.
   *
   * Read first, because `loadState` takes the lock itself: asking afterwards
   * finds our own record and answers "nobody", which is the check working
   * perfectly and looking in the wrong place.
   */
  const heldBy = projectLockHolder(root);
  const key = idempotencyKey(flags);
  const { location, state } = loadState(root);
  if (checkIdempotency(root, key)) return console.log(`Idempotent retry: this baseline is already recorded.`);
  assertKnownOwner(state, required(flags, "owner"));
  const reason = required(flags, "reason").trim();
  if (!reason) throw new PlangonautError("--reason cannot be empty: a baseline records why the history before it is not reproducible.");

  /*
   * Not while another writer is holding the project.
   *
   * A baseline rewrites what the replay proves, and doing that under a lock
   * somebody else owns is the one way to produce a history two processes
   * disagree about. Studio takes a lock for a governed edit; if one is held and
   * it is not ours, this stops.
   */
  if (heldBy) {
    throw new PlangonautError(
      `${heldBy} is holding this project.\n` +
      `A baseline changes what the replay proves, and taking one while another writer has the project open is how two processes come to disagree about the same history.\n` +
      `Close the other writer, or release an abandoned lock with plangonaut unlock --project-root .\nNothing was written.`,
      "PROJECT_STATE_UNTRUSTED",
    );
  }

  const existing = replayFromEvents(root);
  if (existing.replayable && digestOf(existing.state) === digestOf(state)) {
    console.log(`Nothing to do: this project already replays from ${existing.originType} through revision ${existing.throughRevision}.`);
    if (existing.unprovenBefore > 0) console.log(`  ${existing.unprovenBefore} earlier event${existing.unprovenBefore === 1 ? "" : "s"} remain outside that proof.`);
    return;
  }

  const lines = eventLines(root);
  const diagnosis = integrityDiagnosis(root);

  /*
   * What the baseline would prove, and what it would not, before it is taken.
   *
   * A baseline is not reversible in the sense that matters: the events before
   * it stay in the file but stop being part of what replay proves, and somebody
   * reading the project a year later needs that boundary to have been a
   * decision rather than a side effect. So it can be looked at first, and the
   * preview and the real run print the same boundary sentence.
   */
  const boundary = [
    `A baseline would record a new starting point at revision ${Number(state.revision) + 1}.`,
    ``,
    `  events in the file now        ${lines.length}`,
    `  events left outside the proof ${lines.length}${lines.length ? ` (lines 1-${lines.length})` : ""}`,
    `  proven from                   revision ${Number(state.revision) + 1} onward`,
    diagnosis.defect && diagnosis.defect.line > 0
      ? `  the defect it steps over      line ${diagnosis.defect.line}${diagnosis.defect.type ? ` (${diagnosis.defect.type})` : ""}, ${diagnosis.defect.category}`
      : `  the defect it steps over      the history cannot be replayed from any point in it`,
    ``,
    `What a baseline does **not** do: it does not make the events before it reproducible, it does not verify them,`,
    `and it is not retroactive evidence that what they record actually happened. They stay in the file, readable,`,
    `and explicitly outside the proof. Anything resting on them rests on them exactly as much as it did before.`,
  ];

  if (flags["dry-run"] === true) {
    for (const line of boundary) console.log(line);
    console.log(``);
    console.log(`Nothing was written. To record it:`);
    console.log(`  plangonaut baseline --project-root . --reason "${reason}" --owner ${required(flags, "owner")} --operation-id <id> --confirm-token ${baselineToken(root, state)}`);
    return;
  }

  /*
   * Confirmed, with a token that belongs to this project at this revision.
   *
   * A plain `--yes` would confirm whatever the project happened to be when the
   * command ran, which is not what the person looked at in the preview. The
   * token is derived from the state the preview described, so a baseline
   * confirmed against a project that has moved on is refused rather than
   * applied to something nobody read.
   */
  const expectedToken = baselineToken(root, state);
  const suppliedToken = typeof flags["confirm-token"] === "string" ? String(flags["confirm-token"]).trim() : "";
  if (suppliedToken !== expectedToken) {
    for (const line of boundary) console.log(line);
    throw new PlangonautError(
      suppliedToken
        ? `The confirmation token does not match this project at revision ${state.revision}. It was taken against a different state, so what was reviewed is not what would be recorded. Run --dry-run again. Nothing was written.`
        : `A baseline needs confirming. Look at what it would do first:\n  plangonaut baseline --project-root . --dry-run --reason "${reason}" --owner ${required(flags, "owner")}\nthen pass the --confirm-token it prints. Nothing was written.`,
    );
  }

  const at = now();
  const eventId = crypto.randomUUID();
  const stateBackup = backupName(location);
  fs.mkdirSync(path.dirname(stateBackup), { recursive: true });
  fs.copyFileSync(location, stateBackup);
  const eventsLocation = path.join(stateRoot(root), "events.jsonl");
  const eventsBackup = backupName(eventsLocation);
  if (fs.existsSync(eventsLocation)) fs.copyFileSync(eventsLocation, eventsBackup);

  const previousDigest = digestOf(state);
  state.revision = Number(state.revision) + 1;
  state.last_event_id = eventId;
  state.updated_at = at;
  const event: any = {
    event_id: eventId,
    type: "BASELINE_RECORDED",
    state_revision: state.revision,
    at,
    idempotency_key: key,
    replay_origin: true,
    owner: required(flags, "owner"),
    reason,
    reducer_version: REDUCER_VERSION,
    // Who, with what, and over what: the four facts a reader needs to judge a
    // boundary somebody else drew.
    engine_version: VERSION,
    writer: "plangonaut-cli",
    defect_category: diagnosis.defect?.category ?? null,
    defect_line: diagnosis.defect?.line ?? null,
    baseline_state_sha256: previousDigest,
    events_before: lines.length,
    unreproducible_before_revision: Number(state.revision) - 1,
    state_backup: path.relative(root, stateBackup).replaceAll("\\", "/"),
    events_backup: fs.existsSync(eventsBackup) ? path.relative(root, eventsBackup).replaceAll("\\", "/") : null,
  };

  commitState(root, location, state, event, { origin: true });
  console.log(`Recorded a replay baseline at revision ${state.revision}.`);
  console.log(`Everything from here on can be rebuilt from the events. The ${lines.length} event${lines.length === 1 ? "" : "s"} before it stay in the file and stay outside that proof: they were written without the information a replay needs, and none of it has been invented.`);
  console.log(`The previous state and history are preserved at ${event.state_backup} and ${event.events_backup ?? "<no history file>"}.`);
  console.log(``);
  console.log(`The boundary of the proof, stated so it is not mistaken later:`);
  console.log(`- events 1-${lines.length} are readable and unproven. This baseline is not retroactive evidence that what they record happened.`);
  console.log(`- everything from revision ${state.revision} onward replays and is verifiable with plangonaut replay --verify --project-root .`);
}

/**
 * A confirmation that belongs to one project at one revision.
 *
 * Short on purpose — it is typed by a person — and derived from the things that
 * would make the preview stale: which project, which revision, and what its
 * state actually is.
 */
function baselineToken(root: string, state: State): string {
  return sha256(`baseline|${canonicalRelative(root)}|${state.revision}|${digestOf(state)}`).slice(0, 12);
}

/**
 * Interrupted transactions: what they are, and what finishing them would do.
 *
 * Inspection is the default and touches nothing, because the command someone
 * runs when they are frightened should not be the command that changes things.
 */
/**
 * Every directory under `transactions/`, including the ones that are not a
 * transaction any more.
 *
 * A journal that will not parse, and a directory with no journal at all, used to
 * be invisible: the first killed every command with a raw JSON error and the
 * second was skipped for ever while `recover` said everything had finished.
 * Both are now *named*, which is the least a recovery tool owes its user.
 */
function pendingTransactions(root: string): Array<{ id: string; journal: any }> {
  const directory = path.join(stateRoot(root), "transactions");
  const pending: Array<{ id: string; journal: any }> = [];
  if (!fs.existsSync(directory)) return pending;
  for (const entry of fs.readdirSync(directory)) {
    const candidate = path.join(directory, entry);
    if (!fs.statSync(candidate).isDirectory()) continue;
    const journalFile = journalPath(candidate);
    const legacy = path.join(candidate, "manifest.json");
    if (fs.existsSync(journalFile)) {
      try {
        pending.push({ id: entry, journal: readJson(journalFile) });
      } catch {
        pending.push({ id: entry, journal: { phase: "UNREADABLE", event_id: entry, event_type: null } });
      }
    } else if (fs.existsSync(legacy)) {
      try {
        pending.push({ id: entry, journal: { ...readJson(legacy), phase: "LEGACY" } });
      } catch {
        pending.push({ id: entry, journal: { phase: "UNREADABLE", event_id: entry, event_type: null } });
      }
    } else {
      pending.push({ id: entry, journal: { phase: "NO_JOURNAL", event_id: entry, event_type: null } });
    }
  }
  return pending;
}

/**
 * A history whose final line was cut off mid-write.
 *
 * Returns the index of that line, or -1. Only the *last* line qualifies: a
 * malformed line with complete lines after it is damage nobody can undo, and it
 * stays a refusal.
 */
function tornTrailingEvent(root: string): number {
  const lines = eventLines(root);
  if (!lines.length) return -1;
  const last = lines.length - 1;
  if (!lines[last].malformed) return -1;
  if (lines.slice(0, last).some((item) => item.malformed)) return -1;
  return last;
}

function recover(flags: Flags): void {
  const root = resolveProject(required(flags, "project-root"));
  const pending = pendingTransactions(root);
  const torn = tornTrailingEvent(root);

  const stagings = outstandingStagings(root);
  if (!pending.length && torn < 0 && !stagings.length) {
    console.log("No interrupted operation. Every transaction this project started was finished.");
    return;
  }

  for (const item of stagings) {
    console.log(`${item.note.kind} to ${item.note.destination}`);
    console.log(`  started     ${item.note.created_at} by process ${item.note.pid} on ${item.note.host}`);
    console.log(`  phase       ${item.note.phase}`);
    if (!item.present) {
      console.log(
        (item as any).leftover
          ? `  would be    cleared: the package was promoted and still carries its ${STAGING_MARKER}, which records this machine — removing it is what makes the package handable`
          : `  would be    forgotten: the staging directory is no longer there, so the operation left nothing behind`,
      );
    } else if (item.alive) {
      console.log(`  would be    left alone: that process is still running on this machine`);
    } else {
      console.log(`  would be    discarded: an unfinished package is never promoted, and re-running the export costs nothing`);
    }
  }

  if (torn >= 0) {
    console.log(`The last line of .beave/events.jsonl was cut off mid-write (line ${torn + 1}).`);
    console.log(`  An append is the last durable write of an operation, so a partial final line cannot be a completed one:`);
    console.log(`  dropping it can only discard an operation that never finished. Every earlier line reads correctly.`);
    console.log(`  would be    removed, after a copy of the whole file is kept under .beave/backups/`);
  }

  for (const item of pending) {
    const phase = item.journal.phase;
    const plan =
      phase === "COMMITTING"
        ? "completed: its event is the point at which it happened, so recovery finishes the write from the content the journal staged"
        : phase === "COMMITTED"
          ? "closed: every file was written and only the journal is left"
          : phase === "LEGACY"
            ? "decided by the rule its own journal shipped with: finished if the event is in the history, undone otherwise"
            : phase === "UNREADABLE"
              ? "left alone, and reported: its journal cannot be read, so nothing here knows what it was doing. Nothing will be changed automatically"
              : phase === "NO_JOURNAL"
                ? "left alone, and reported: the directory carries no journal, so there is nothing to complete or undo. Remove it by hand once you have looked at it"
                : "undone: it never reached the point where it happened, so the project goes back to before it started";
    console.log(`${item.journal.event_type ?? "operation"} ${item.id}`);
    console.log(`  phase       ${phase}`);
    console.log(`  started     ${item.journal.created_at ?? "not recorded"}`);
    console.log(`  operation   ${item.journal.operation_id ?? "not recorded"}`);
    console.log(`  would be    ${plan}`);
  }

  if (flags.apply !== true) {
    console.log(`\nNothing was changed. Run the same command with --apply to carry that out, or — for an interrupted operation — let the next command that touches this project do it: recovery is not optional and every command runs it. A torn final line is the one thing that is never repaired automatically.`);
    return;
  }

  for (const note of clearOwnAbandonedStagings(root)) console.log(note);

  if (torn >= 0) {
    const location = path.join(stateRoot(root), "events.jsonl");
    const backup = backupName(location);
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    fs.copyFileSync(location, backup);
    const kept = eventLines(root).slice(0, torn).map((item) => item.line);
    atomicWrite(location, kept.length ? `${kept.join(NL)}${NL}` : "");
    console.log(`Removed the torn final line. The file as it was is at ${path.relative(root, backup).replaceAll("\\", "/")}.`);
  }

  recoverFileTransactions(root);
  if (pending.length) console.log(`${pending.length} interrupted operation${pending.length === 1 ? "" : "s"} resolved; the receipts are under .beave/recovery/.`);
  console.log(`Run \`plangonaut replay --project-root . --verify\` to see what the project is now.`);
}

function assertPendingState(root: string, state: State, event: any): void {
  const errors = stateErrors(root, state, event);
  if (errors.length) throw new PlangonautError(`Transaction preflight failed:\n- ${errors.join("\n- ")}\nNo changes written.`);
}

function assertKnownOwner(state: any, owner: string): void {
  const known = new Set(Object.values(state.decision_owners ?? {}).map((value) => String(value).trim()));
  if (!known.has(owner.trim())) throw new PlangonautError(`Owner is not one of the confirmed decision owners: ${owner}`);
}

function questionnaire(): any[] {
  const text = fs.readFileSync(path.join(SKILL_ROOT, "references", "questionnaire.md"), "utf8");
  const modules: any[] = [];
  let current: any = null;
  for (const line of text.split(/\r?\n/)) {
    const match = /^##\s+(\d+)\.\s+(.+?)\s*$/.exec(line);
    if (match) {
      current = { id: Number(match[1]), title: match[2], questions: [] };
      modules.push(current);
    } else if (current && line.startsWith("- ") && line.includes("?")) {
      current.questions.push(line.slice(2).trim());
    }
  }
  if (modules.map((item) => item.id).join(",") !== Array.from({ length: 17 }, (_, index) => index).join(",")) {
    throw new PlangonautError("Questionnaire module IDs must be 0..16");
  }
  return modules;
}

function loadState(root: string): { location: string; state: State } {
  acquireProjectLock(root, runningCommand);
  recoverFileTransactions(root);
  const location = path.join(stateRoot(root), "state.json");
  // A project whose state file is gone but whose history is intact is a project
  // that can be rebuilt, and saying so is more use than the ENOENT this used to
  // raise from four different commands.
  if (!fs.existsSync(location) && fs.existsSync(path.join(stateRoot(root), "events.jsonl"))) {
    // A history without a state is a project whose records disagree with each
    // other, not a folder without a project: there is something here to repair.
    throw new PlangonautError(
      `.beave/state.json is missing, and the event history is still here. Rebuild the state from it:\n` +
        `  plangonaut replay --project-root . --repair --operation-id <id>\n` +
        `Nothing was changed.`,
      "PROJECT_STATE_UNTRUSTED",
    );
  }
  if (!fs.existsSync(location)) {
    throw new PlangonautError(
      `No Plangonaut project at ${root}: there is no ${STATE_DIR}/state.json, and no ${LEGACY_STATE_DIR}/state.json either. Create one with \`plangonaut init --project-root . --project-name NAME --project-mode Genesis --interaction-mode Standard --owners-file owners.json --operation-id <id>\`.`,
      "NOT_PLANGONAUT_PROJECT",
    );
  }
  const state = readJson(location, "PROJECT_STATE_UNTRUSTED") as State;
  // The revision this command is working from, written into the lock so a second
  // process can say what it is waiting behind rather than only that it is waiting.
  noteObservedRevision(Number(state?.revision ?? 0));
  // The read-modify-write window opens here: the revision this command will
  // build on has been read. `BEAVE_TEST_SYNC_AT=read` stops the process inside it.
  testSyncPoint("read");
  return { location, state };
}

function activeModule(state: State): Module | null {
  return state.modules.find((item) => !new Set(["CONFIRMED", "DEFERRED", "NOT APPLICABLE"]).has(item.status)) ?? null;
}

function detectCycles(dependencies: Dependency[]): string[] {
  const adj = new Map<string, string[]>();
  for (const dep of dependencies) {
    if (!adj.has(dep.from)) adj.set(dep.from, []);
    adj.get(dep.from)!.push(dep.to);
  }
  const visited = new Set<string>();
  const recStack = new Set<string>();
  const cycles: string[] = [];

  function dfs(node: string) {
    if (recStack.has(node)) {
      cycles.push(`Cycle detected involving node ${node}`);
      return;
    }
    if (visited.has(node)) return;
    visited.add(node);
    recStack.add(node);
    for (const neighbor of adj.get(node) || []) {
      dfs(neighbor);
    }
    recStack.delete(node);
  }

  for (const node of adj.keys()) dfs(node);
  return cycles;
}

/**
 * One recorded blocker.
 *
 * `RESOLVED` keeps the record. Deleting it would erase the only evidence the
 * project was ever held up, which is the part of the history most worth keeping:
 * a blocker that happened and was cleared is a fact about how the work went.
 */
interface Blocker {
  id: string;
  title: string;
  reason: string;
  status: "OPEN" | "RESOLVED";
  owner: string;
  recorded_at: string;
  evidence?: { path: string; sha256: string };
  resolved_at?: string;
  resolved_by?: string;
  resolution?: string;
  revision: number;
  updated_at: string;
}

/** Somebody looked, found nothing open, and put their name to it. */
interface BlockerVerification {
  at: string;
  by: string;
  /** The state revision that was verified. A later one is not covered by it. */
  state_revision: number;
  event_id: string;
  note?: string;
}

const BLOCKER_STATUSES = new Set(["OPEN", "RESOLVED"]);

/** Every entry, whatever shape it was written in. */
function blockerEntries(state: State): (string | Blocker)[] {
  return Array.isArray(state.blockers) ? state.blockers : [];
}

/** The typed records only. Legacy strings are not records and never become them. */
function blockerRecords(state: State): Blocker[] {
  return blockerEntries(state).filter((item): item is Blocker => typeof item === "object" && item !== null);
}

/** Entries nobody has recorded as resolved. Legacy strings are all of them. */
function openBlockers(state: State): (string | Blocker)[] {
  return blockerEntries(state).filter((item) => (typeof item === "string" ? true : item.status !== "RESOLVED"));
}

/**
 * What a zero is worth, said next to the zero.
 *
 * It used to read "(nothing writes that ledger, so this is not a verified zero)"
 * unconditionally, which was true and is not any more. A zero now means one of
 * three things and the reader is told which: verified by somebody, or merely
 * nothing recorded, or everything recorded has been resolved without anyone
 * checking since.
 */
/**
 * The blocker section every human output shares.
 *
 * Open ones first, because they are what stops work; resolved ones after, kept
 * rather than dropped — a blocker that happened and was cleared is part of how
 * the project went, and the ledger is where that is written down.
 */
function blockerReportLines(state: State): string[] {
  const entries = blockerEntries(state);
  const open = openBlockers(state);
  const resolved = blockerRecords(state).filter((item) => item.status === "RESOLVED");
  const verification = state.blockers_none_verified;

  if (!entries.length) {
    return [
      verification
        ? `- None. ${verification.by} verified at ${verification.at} that no blocker is open, against revision ${verification.state_revision}.`
        : "- None recorded, and nobody has recorded that they looked. An empty ledger is not evidence that the project has none: record what you find with `plangonaut blocker-record`, or record the absence with `plangonaut blocker-verify-none`.",
    ];
  }

  const lines: string[] = [];
  if (open.length) lines.push(...open.map((item) => `- OPEN: ${blockerLine(item)}`));
  else if (verification) {
    lines.push(`- No blocker is open. ${verification.by} verified this at ${verification.at}, against revision ${verification.state_revision}.`);
  } else {
    lines.push("- No blocker is open, and nobody has verified it since the last one was resolved. Record that with `plangonaut blocker-verify-none` if it is true.");
  }
  if (resolved.length) lines.push(...resolved.map((item) => `- RESOLVED: ${blockerLine(item)}`));
  return lines;
}

function blockerZeroCaveat(state: State, open: number): string {
  if (open !== 0) return "";
  const verification = state.blockers_none_verified;
  if (verification) return ` (verified by ${verification.by} at ${verification.at})`;
  if (blockerEntries(state).length) {
    return " (every recorded blocker is resolved, but nobody has verified since that none is open)";
  }
  return " (nothing is recorded and nobody has verified it, so this is not a verified zero)";
}

/** One line for a human, whichever shape the entry has. */
function blockerLine(entry: string | Blocker): string {
  if (typeof entry === "string") {
    return `${entry} (recorded as free text before the blocker ledger existed: no owner, no date, and no recorded status, so it is counted as open)`;
  }
  const head = `${entry.id} ${entry.title} — ${entry.status}, recorded by ${entry.owner} at ${entry.recorded_at}`;
  if (entry.status !== "RESOLVED") return `${head}. Reason: ${entry.reason}`;
  return `${head}. Reason: ${entry.reason}. Resolved by ${entry.resolved_by} at ${entry.resolved_at}: ${entry.resolution}`;
}

const LEDGER_RULES: Record<string, { prefix: string; statuses?: Set<string>; array: keyof State }> = {
  decision: { prefix: "DEC", statuses: new Set(["PROPOSED", "APPROVED", "REJECTED", "SUPERSEDED"]), array: "decisions" },
  requirement: { prefix: "REQ", statuses: new Set(["DRAFT", "ACTIVE", "DEFERRED", "OBSOLETE"]), array: "requirements" },
  task: { prefix: "TSK", statuses: new Set(["BACKLOG", "READY", "IN_PROGRESS", "REVIEW", "DONE", "BLOCKED"]), array: "tasks" },
  dependency: { prefix: "DEP", statuses: new Set(["BLOCKS", "REQUIRES", "RELATES_TO"]), array: "dependencies" },
  risk: { prefix: "RSK", statuses: new Set(["IDENTIFIED", "MITIGATED", "ACCEPTED", "REALIZED"]), array: "risks" },
  evidence: { prefix: "EVD", array: "evidence" },
  agent: { prefix: "AGT", statuses: new Set(["PROPOSED", "ACTIVE", "RETIRED"]), array: "agents" },
  checkpoint: { prefix: "CHK", array: "checkpoints" }
};

// The exact next action has two possible authors: this engine, and a person who
// recorded one deliberately with `checkpoint --next-action` or `reconcile
// --next-action`. Nothing in schema v3 records which, so the engine recognises
// its own sentences instead. A false positive here would suppress a warning; a
// false negative would print one that is merely noise. Both are recoverable, and
// the list is exact rather than fuzzy for that reason.
const GENERATED_NEXT_ACTIONS: RegExp[] = [
  /^Run `plangonaut next --project-root \.` and discuss module 1\.$/,
  /^Discuss module \d+ — [\s\S]*\.$/,
  /^Review coverage, then proceed to G2\.$/,
  /^Resolve \d+ recorded contradictions? before continuing; plangonaut validate --strict lists them\.$/,
  /^Reconcile OVR-[a-f0-9]+(?:: identify impacted decisions, artifacts, tasks, agents, tests, and gates\.| before continuing\.)$/,
  /^Reconciled OVR-[a-f0-9]+\. Continue from the recorded plan; no next action was supplied\.$/,
  /^Proceed to G\d+\.$/,
  /^Proceed to G\d+\. G\d+ passed with a condition owned by [\s\S]+, to review by \d{4}-\d{2}-\d{2}: [\s\S]+$/,
  /^Resolve blockers for G\d+ and retry\.$/,
  /^Answer the open questions? \(QNA-\d{4,}(?:, QNA-\d{4,})*\) with plangonaut qa-answer, then settle (?:it|each) with plangonaut qa-settle\.$/,
  /*
   * `qa-settle` writes these, and they were missing from this list — so the
   * engine treated its own sentence as a person's and refused to move it. A
   * fifth fresh-agent pilot recorded a question and then read a context pack
   * that said, at the top, "no next question is recorded yet" and, twenty lines
   * below, "Ask QNA-0002, which is recorded as planned". A file that asserts and
   * denies the same thing is the defect this list exists to prevent; a sentence
   * missing from it turns the protection into the fault.
   *
   * A bounded check then found three more ways to escape the list, all of them
   * the engine failing to recognise its own handwriting: a question id of five
   * digits or more (`QNA-10000` is legal, and `\d{4}` did not match it), a
   * multi-line `--next-question`, and a multi-line gate `--consequence` — `.*`
   * does not cross a newline without the `s` flag. The patterns are widened
   * here, and `generatedSentence()` flattens the free text that goes into them,
   * so the two halves cannot drift apart again by the width of a line break.
   */
  /^Ask QNA-\d{4,}: [\s\S]*$/,
  /^Continue the interview from QNA-\d{4,}; no next question is recorded yet\.$/,
  /^The interview has nothing open\. Ask the next question with plangonaut qa-ask, or record what module \d+ has settled\.$/,
];

/**
 * One line, always.
 *
 * Free text from a caller — a next question, a gate condition — used to be
 * dropped into the recorded next action verbatim. A newline in it broke the
 * pattern that recognises the sentence as the engine's own *and* broke the
 * `- Exact next action:` list item in every report that renders it. Flattened
 * here, once, rather than guarded for at each of the places that read it.
 */
function generatedSentence(text: string): string {
  return text.replace(/\s*\r?\n\s*/g, " ").trim();
}

/**
 * What the interview is actually waiting for, as a sentence.
 *
 * Built from the ledger every time, because the alternative is what the bounded
 * check found twice: `qa-settle` announcing "no next question is recorded yet"
 * while three were, and `qa-close` / `qa-supersede` leaving the recorded action
 * naming questions that can no longer be answered — a fresh recipient told to
 * obey an instruction that fails.
 */
function openQuestionsSentence(state: State): string {
  const open = (state.interview_log ?? [])
    .filter((item: any) => new Set(["ASKED", "PLANNED"]).has(item.status))
    .map((item: any) => item.id);
  if (!open.length) {
    const active = activeModule(state);
    return `The interview has nothing open. Ask the next question with plangonaut qa-ask, or record what module ${active ? active.id : 1} has settled.`;
  }
  return `Answer the open question${open.length === 1 ? "" : "s"} (${open.join(", ")}) with plangonaut qa-answer, then settle ${open.length === 1 ? "it" : "each"} with plangonaut qa-settle.`;
}

function engineWroteNextAction(value: unknown): boolean {
  if (typeof value !== "string" || !value.trim()) return true;
  return GENERATED_NEXT_ACTIONS.some((pattern) => pattern.test(value.trim()));
}

/**
 * Advance the exact next action, but only when the engine is the one who wrote it.
 *
 * A command that moves the interview forward may replace its own sentence. It may
 * not replace a person's: `exact_next_action` is what a fresh recipient of the
 * folder is told to obey, and a recipient reads the delivered folder, not the
 * terminal of whoever prepared it. Warning about the loss was not enough — the
 * warning stays with the operator while the wrong instruction travels.
 *
 * Returns the note to print. When a human action was preserved, the note carries
 * the suggestion instead of applying it.
 */
function advanceGeneratedNextAction(state: State, generated: string): string | null {
  const previous = state.exact_next_action;
  if (engineWroteNextAction(previous)) {
    state.exact_next_action = generated;
    return null;
  }
  // Composed here, counted where it is printed.
  //
  // Counting here made the number a lie, which the first run of it showed:
  // `qa-ask` and `qa-answer` both compute this note and may discard it, so by
  // the first `qa-settle` that actually printed anything the ledger already
  // said "2nd time" about a sentence nobody had yet seen once. An occurrence
  // counter has to count occurrences, not opportunities.
  return (
    `The recorded exact next action was written by a person, so it is kept unchanged. Suggested instead: ${generated}\n` +
    `To replace it deliberately, use plangonaut checkpoint --next-action or plangonaut reconcile --next-action.`
  );
}

/**
 * The next-action note as it should reach the terminal: full once, then brief.
 *
 * The brief form keeps the suggestion and drops the explanation, which is the
 * only split that makes sense here. The suggestion is different every time — it
 * names the module or the operation the engine would have pointed at — so
 * dropping it would lose information with each repetition. The two lines about
 * *why* the sentence was kept and *how* to replace it deliberately are identical
 * on every occurrence, and those are what stop being read.
 */
function nextActionNotice(root: string, note: string): string {
  const suggestion = /Suggested instead:\s*([^\n]+)/.exec(note)?.[1]?.trim();
  return echoNotice(
    root,
    "human-next-action-kept",
    note,
    `The exact next action is still the one a person wrote; it was kept.` +
      (suggestion ? ` Suggested instead: ${suggestion}` : "")
  );
}

// ---------------------------------------------------------------------------
// Notices that are right to give and wrong to repeat
// ---------------------------------------------------------------------------

/**
 * A standing condition said in full once, then briefly, and counted.
 *
 * The rule the pilot ran into is a good rule: a next action a person wrote is
 * not overwritten by the engine, and the engine says so instead of doing it in
 * silence. What went wrong is repetition. Every `qa-settle` printed the same two
 * lines, six times in one session, about a condition that had not changed since
 * the first — and a warning printed identically six times is not read the sixth
 * time, or the second. Volume was defeating the rule it was there to enforce.
 *
 * Suppression is therefore about *repetition*, not about the rule: the condition
 * is still reported every single time, and the first report is complete. What
 * shrinks is the restatement. The count is kept so the brief form can say how
 * many times this has now happened, which is information the full text never
 * carried.
 *
 * It lives in `.plangonaut/notices.json` rather than in `state.json` on purpose.
 * It is bookkeeping about what this machine has already printed — not a fact
 * about the project, not replayable, not something that should travel in the
 * package or bump a revision. `stateDigest` skips it for the same reason it
 * skips `lock.json`.
 */
const NOTICES_FILE = "notices.json";

function recordNotice(root: string, key: string): number {
  const location = path.join(stateRoot(root), NOTICES_FILE);
  let ledger: Record<string, { count: number; first_at: string; last_at: string }> = {};
  try {
    ledger = JSON.parse(fs.readFileSync(location, "utf8"));
    if (!ledger || typeof ledger !== "object") ledger = {};
  } catch {
    ledger = {};
  }
  const at = now();
  const entry = ledger[key];
  const count = (entry?.count ?? 0) + 1;
  ledger[key] = { count, first_at: entry?.first_at ?? at, last_at: at };
  try {
    fs.mkdirSync(path.dirname(location), { recursive: true });
    fs.writeFileSync(location, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
  } catch {
    // A notice ledger that cannot be written must never fail an operation. The
    // cost is that the full text is printed again, which is the old behaviour.
  }
  return count;
}

/** Everything this machine has been told, and how often. For `status`. */
function noticeSummary(root: string): Record<string, { count: number; first_at: string; last_at: string }> {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(stateRoot(root), NOTICES_FILE), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** `2nd`, `3rd`, `11th`: English ordinals, including the three that are not -th. */
function ordinal(value: number): string {
  const tens = value % 100;
  if (tens >= 11 && tens <= 13) return `${value}th`;
  return `${value}${({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[value % 10] ?? "th"}`;
}

/** The full text the first time, a one-line restatement afterwards. */
function echoNotice(root: string, key: string, full: string, brief: string): string {
  const count = recordNotice(root, key);
  if (count === 1) return full;
  return `${brief} (${ordinal(count)} time on this project; plangonaut status reports every standing notice and its count)`;
}

function validTypedId(value: unknown, prefix: string): boolean {
  return typeof value === "string" && new RegExp(`^${prefix}-[A-Z0-9][A-Z0-9_-]{0,63}$`).test(value);
}

function nonEmpty(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * The one spelling every persisted relative path is written in: `/`.
 *
 * A ledger written on Windows used to record `ans\m1.md`. On the POSIX machine
 * that receives the package that is not a path at all, it is a file name with a
 * backslash in it — so `validate` reported the file missing, and the delivery to
 * another agent is the declared scenario, not an edge case.
 *
 * The rule (project decision, blocker 4): `/` is canonical for every relative
 * path persisted in the ledger, the events, the manifest and the package. A
 * reader must accept both forms, because records written before the rule exist
 * and must stay readable — that is what this function is for. It is applied at
 * the three choke points every recorded relative path passes through
 * (`safeProjectRelative`, `safeArtifactPath`, `existingFileInside`), so a
 * Windows-spelled record resolves and is contained the same way on both
 * platforms.
 *
 * The cost, stated: a POSIX file whose name genuinely contains a backslash
 * cannot be recorded. That is the safe direction of the trade. Without it,
 * `..\..\etc` and `.beave\secret` pass POSIX containment checks as single
 * segments — a package exported from Windows would arrive weaker than it left.
 */
function canonicalRelative(value: unknown): string {
  return typeof value === "string" ? value.replaceAll("\\", "/") : "";
}

/** True when two recorded relative paths name the same file in either spelling. */
function sameRecordedPath(left: unknown, right: unknown): boolean {
  return canonicalRelative(left) === canonicalRelative(right);
}

/** Absolute location of a path the ledger recorded, in either spelling. */
function resolveRecorded(root: string, relative: unknown): string {
  return path.resolve(root, canonicalRelative(relative));
}

function safeProjectRelative(value: unknown): boolean {
  if (!nonEmpty(value)) return false;
  const canonical = canonicalRelative(value);
  if (!canonical || path.isAbsolute(canonical) || path.isAbsolute(String(value))) return false;
  const normalized = path.normalize(canonical);
  return normalized !== ".." && !normalized.startsWith(`..${path.sep}`);
}

/**
 * Every directory a recorded path may not point into.
 *
 * It was one name. The rename made it three, and a guard that knew the old one
 * only would have let a caller record an artifact **inside the new ledger** —
 * which is the whole thing this check exists to prevent, arriving through the
 * door the rename opened. Found by `a preview refuses the paths the save
 * refuses`, which is exactly the test that should have found it.
 *
 * The staging prefix is here too: a migration in flight owns that directory,
 * and a document recorded into it would be destroyed by the migration's own
 * cleanup.
 */
const RESERVED_DIRS = [STATE_DIR, LEGACY_STATE_DIR];
const RESERVED_PREFIX = MIGRATION_STAGING_PREFIX;

function isReservedTop(segment: string): boolean {
  const lower = segment.toLowerCase();
  return RESERVED_DIRS.includes(lower) || lower.startsWith(RESERVED_PREFIX);
}

function safeArtifactPath(value: unknown): boolean {
  if (!safeProjectRelative(value)) return false;
  return !isReservedTop(path.normalize(canonicalRelative(value)).split(path.sep)[0]);
}

/**
 * Why an artifact path was refused, in the words of the reason it was refused for.
 *
 * `safeArtifactPath` answers no to two unrelated questions — the path leaves the
 * project, or the path is inside a reserved directory — and the callers all
 * reported the second. Somebody who passed an absolute path, or one climbing out
 * with `..`, was told about the ledger directory, which is not what happened and
 * does not suggest the fix.
 */
function artifactPathRefusal(kind: string, value: unknown): string | null {
  if (safeArtifactPath(value)) return null;
  if (!safeProjectRelative(value)) {
    return `${kind} must be a path inside the project, written relative to its root. ` +
      `\`${String(value)}\` is not: an absolute path, or one that climbs out with "..", ` +
      `would put the record outside the folder that travels with it.`;
  }
  return `${kind} must stay outside the reserved ${STATE_DIR} and ${LEGACY_STATE_DIR} directories, which hold the ledger itself.`;
}

function existingFileInside(root: string, relative: string): string | null {
  if (!safeProjectRelative(relative)) return null;
  // Both spellings resolve to the same file: see `canonicalRelative`.
  const candidate = path.resolve(root, canonicalRelative(relative));
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) return null;
  const realRoot = fs.realpathSync.native(root);
  const realFile = fs.realpathSync.native(candidate);
  const relation = path.relative(realRoot, realFile);
  if (relation === ".." || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) return null;
  return realFile;
}

function duplicateIds(items: any[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const item of items) {
    if (seen.has(item?.id)) duplicates.add(item.id);
    seen.add(item?.id);
  }
  return [...duplicates];
}

// ---------------------------------------------------------------------------
// D5 / FR-024 — progress forecast and rework-loop detection.
//
// The requirement is `docs/decisions/2026-09-10-progress-forecast-and-loop-detection.md`
// and `planning/CLAUDE_PROGRESS_FORECAST_ADDENDUM.md`. The observed defect is an
// agent that says "one operation remains" and is then contradicted by a
// verification that had not run yet: the statement is true against the plan and
// still misleads, because the plan does not contain the work the verification is
// about to create.
//
// Two rules shape everything below.
//
//  1. **No percentage is stored anywhere.** A percentage whose denominator can
//     still change is presented as a fact and is not one. Quantities are ranges
//     of observable things — questions, operations, cycles — and a single number
//     means "known", not "guessed precisely".
//  2. **The engine never overwrites the caller's judgement, and never accepts a
//     wrong one in silence.** It records `cycle_state` exactly as supplied, derives
//     what it can see for itself into `signals[]`, and says out loud when the two
//     disagree. Silently correcting a person and silently agreeing with a person
//     are the same failure seen from two sides.
// ---------------------------------------------------------------------------

function readEvents(root: string): any[] {
  const location = path.join(stateRoot(root), "events.jsonl");
  if (!fs.existsSync(location)) return [];
  const parsed: any[] = [];
  for (const line of fs.readFileSync(location, "utf8").split(/\r?\n/).filter(Boolean)) {
    try {
      parsed.push(JSON.parse(line));
    } catch {
      continue;
    }
  }
  return parsed;
}

function forecastRangeText(range: ForecastRange): string {
  return range.min === range.max ? `${range.min} (known)` : `${range.min}-${range.max}`;
}

/**
 * Read one `MIN-MAX` option.
 *
 * A percentage gets its own refusal rather than falling through to "unparseable",
 * because someone typing `--questions 60%` is doing the exact thing the decision
 * forbids and deserves to be told which rule they hit.
 */
function parseForecastRange(flags: Flags, key: string): ForecastRange {
  const raw = required(flags, key).trim();
  if (raw.includes("%")) {
    throw new PlangonautError(
      `--${key} does not take a percentage. A percentage whose denominator can still change is presented as a fact and is not one, which is what FR-024 exists to prevent. Give an observable range like 3-8, or a single number when the quantity is known. Nothing was written.`
    );
  }
  const match = /^(\d{1,6})(?:\s*-\s*(\d{1,6}))?$/.exec(raw);
  if (!match) {
    throw new PlangonautError(
      `--${key} must be a range like 3-8, or a single number when the quantity is known; received ${raw}. Nothing was written.`
    );
  }
  const min = Number(match[1]);
  const max = match[2] === undefined ? min : Number(match[2]);
  if (max < min) {
    throw new PlangonautError(`--${key} has an inverted range: ${raw}. The lower bound must not exceed the upper bound. Nothing was written.`);
  }
  return { min, max };
}

/** What the engine counts for itself. See `ForecastDerived`. */
function forecastDerived(state: State, events: any[]): ForecastDerived {
  return {
    // Open ones. Counting every entry would have made resolving a blocker
    // invisible to the forecast and left a cleared project looking stuck.
    open_blockers: openBlockers(state).length,
    open_overrides: (state.human_overrides ?? []).filter((item) => item.status === "OPEN").length,
    tasks_by_status: Object.fromEntries(
      TASK_STATUSES.map((status) => [status, (state.tasks ?? []).filter((item) => item.status === status).length])
    ),
    // Counted from `current_gate`, not from the gate ledger. G0 is passed by `init`
    // and never written as a gate record, so counting recorded outcomes would
    // overstate the remainder by one on every project ever created.
    gates_remaining: Math.max(0, 13 - Number(String(state.current_gate ?? "G0").slice(1))),
    unresolved_modules: (state.modules ?? []).filter((item) => !MODULE_TERMINAL_STATUSES.has(item.status)).map((item) => item.id),
    open_findings: (state.risks ?? []).filter((item) => OPEN_RISK_STATUSES.has(item.status)).length,
    evidence_records: (state.evidence ?? []).length,
    status_history_events: events.filter((event) => typeof event?.record_status === "string").length,
  };
}

/**
 * Work that was declared finished and came back, per ledger record.
 *
 * Read from `record_status` on the ledger events, which is the only place a
 * project's status history exists. A **reopening** is deliberately narrow:
 *
 *  - a task that left `DONE` for anything else — work declared finished that
 *    returned;
 *  - a risk that left `MITIGATED` or `ACCEPTED` for `IDENTIFIED` or `REALIZED`.
 *
 * `REVIEW -> IN_PROGRESS` is not counted. A review sending work back is the
 * review working, and counting it would make the loop signal fire on healthy
 * projects, which is the fastest way to make a warning unreadable.
 *
 * The map is empty for every project written before ALN-008, because those events
 * carry no `record_status`. That is why `derived.status_history_events` is stored:
 * an absent signal must be readable as "not observable here" rather than as
 * "did not happen".
 */
function reopenedRecords(events: any[]): Map<string, number> {
  const last = new Map<string, string>();
  const reopenings = new Map<string, number>();
  for (const event of events) {
    const id = event?.ledger_id;
    const status = event?.record_status;
    if (typeof id !== "string" || typeof status !== "string") continue;
    const previous = last.get(id);
    last.set(id, status);
    if (previous === undefined) continue;
    const isTaskReopening = String(event.type ?? "").startsWith("TASK_") && previous === "DONE" && status !== "DONE";
    const isRiskReopening =
      String(event.type ?? "").startsWith("RISK_") && CLOSED_RISK_STATUSES.has(previous) && OPEN_RISK_STATUSES.has(status);
    if (isTaskReopening || isRiskReopening) reopenings.set(id, (reopenings.get(id) ?? 0) + 1);
  }
  return reopenings;
}

function forecastResidual(entry: { questions: ForecastRange; operations: ForecastRange; cycles: ForecastRange }): number {
  return entry.questions.max + entry.operations.max + entry.cycles.max;
}

/**
 * The D5 conditions the engine can actually observe, computed from recorded data.
 *
 * What is NOT here, and why: *"the agent announced a final step more than once and
 * then added work"* is a fact about the conversation. Nothing in `state.json` or
 * `events.jsonl` records what was said, so the engine cannot see it and must not
 * pretend to. It stays the caller's responsibility, enforced in the semantic skill.
 */
function forecastSignals(
  entry: ProgressForecast,
  previous: ProgressForecast | null,
  history: ProgressForecast[],
  reopenings: Map<string, number>,
  operationsSincePrevious: number
): ForecastSignal[] {
  const signals: ForecastSignal[] = [];

  if (previous) {
    const residual = forecastResidual(entry);
    const previousResidual = forecastResidual(previous);
    const phaseClosed =
      entry.phase.trim() !== previous.phase.trim() ||
      entry.derived.gates_remaining < (previous.derived?.gates_remaining ?? entry.derived.gates_remaining);
    if (residual > previousResidual && !phaseClosed) {
      // How many consecutive updates the residual has now grown for. The addendum
      // says "per due aggiornamenti consecutivi"; the contract says "across two
      // consecutive forecasts", which is one growth step. The signal is raised on
      // the contract's reading and the count is reported, so a reader can tell a
      // first growth from a third without the engine choosing for them.
      // Every forecast this project has recorded, oldest first, with the one being
      // written at the end. `history` does not yet contain `previous` at this point
      // — `previous` is still the current `progress_forecast` — so it is put back in
      // explicitly rather than counted as absent.
      const chain = [...history, previous, entry];
      let consecutive = 0;
      for (let index = chain.length - 1; index > 0; index -= 1) {
        if (forecastResidual(chain[index]) > forecastResidual(chain[index - 1])) consecutive += 1;
        else break;
      }
      signals.push({
        code: "RESIDUAL_GREW_WITHOUT_PHASE_CLOSING",
        implies_cycle_state: "RISCHIO_LOOP",
        observed: `The residual grew from ${previousResidual} to ${residual} without a phase closing (phase is still "${entry.phase}" and ${entry.derived.gates_remaining} gates remain, as before). It has now grown for ${consecutive} consecutive forecast${consecutive === 1 ? "" : "s"}.`,
        detail: {
          previous_residual: previousResidual,
          residual,
          consecutive_growths: consecutive,
          phase: entry.phase,
          gates_remaining: entry.derived.gates_remaining,
        },
      });
    }

    if (entry.phase.trim() === previous.phase.trim()) {
      const widened = (["questions", "operations", "cycles"] as const).filter(
        (key) => entry[key].max - entry[key].min > previous[key].max - previous[key].min
      );
      if (widened.length) {
        signals.push({
          code: "SAME_PHASE_WIDER_RANGE",
          implies_cycle_state: "RISCHIO_LOOP",
          observed: `Two consecutive forecasts carry the same phase ("${entry.phase}") and a wider range: ${widened
            .map((key) => `${key} ${forecastRangeText(previous[key])} became ${forecastRangeText(entry[key])}`)
            .join("; ")}.`,
          detail: { phase: entry.phase, widened },
        });
      }
    }

    // "Operations repeated without producing new evidence or reducing blockers and
    // findings." All three clauses of the addendum are required, not just the one
    // the contract summarises. Without "repeated" and "no new evidence" the signal
    // fires on any project that records two ordinary ledger writes, and a warning
    // that is always on is not a warning. The counts are in `detail` either way.
    const openNow = entry.derived.open_blockers + entry.derived.open_findings;
    const openBefore = (previous.derived?.open_blockers ?? 0) + (previous.derived?.open_findings ?? 0);
    const newEvidence = entry.derived.evidence_records - (previous.derived?.evidence_records ?? 0);
    if (operationsSincePrevious >= 2 && openNow > 0 && openNow >= openBefore && newEvidence <= 0) {
      signals.push({
        code: "OPERATIONS_WITHOUT_A_FALL_IN_BLOCKERS_OR_FINDINGS",
        implies_cycle_state: "RISCHIO_LOOP",
        observed: `${operationsSincePrevious} operations were recorded since the previous forecast, no evidence record was added, and open blockers plus findings did not fall (${openBefore} before, ${openNow} now).`,
        detail: {
          operations_since_previous_forecast: operationsSincePrevious,
          open_blockers_and_findings_before: openBefore,
          open_blockers_and_findings_now: openNow,
          new_evidence_records: newEvidence,
        },
      });
    }
  }

  // A "family" here is one ledger record. Nothing in the ledgers groups defects
  // into families, so the engine uses the identity it actually has and names it,
  // rather than inferring a grouping nobody recorded.
  const repeated = [...reopenings.entries()].filter(([, count]) => count >= 2).sort(([a], [b]) => (a < b ? -1 : 1));
  if (repeated.length) {
    signals.push({
      code: "DEFECT_FAMILY_REOPENED_AFTER_TWO_CYCLES",
      implies_cycle_state: "RISCHIO_LOOP",
      observed: `Work declared finished returned after two correction cycles: ${repeated
        .map(([id, count]) => `${id} reopened ${count} times`)
        .join("; ")}. One ledger record is treated as one defect family, because nothing in the ledgers groups defects.`,
      detail: { records: Object.fromEntries(repeated) },
    });
  }

  return signals;
}

function impliedCycleState(signals: ForecastSignal[]): string | null {
  let best: string | null = null;
  for (const signal of signals) {
    const rank = CYCLE_STATE_RANK[signal.implies_cycle_state];
    if (rank === undefined) continue;
    if (best === null || rank > CYCLE_STATE_RANK[best]) best = signal.implies_cycle_state;
  }
  return best;
}

/**
 * The sentence printed and shown when the recorded cycle state is weaker than what
 * the derived signals imply. `null` when there is no disagreement.
 *
 * It is a sentence and not a correction, and that is the whole design: the engine
 * records what the caller said, records the signal beside it, and names the gap.
 */
function forecastDisagreement(entry: ProgressForecast): string | null {
  const implied = impliedCycleState(entry.signals ?? []);
  if (!implied) return null;
  const declared = CYCLE_STATE_RANK[entry.cycle_state];
  if (declared === undefined || CYCLE_STATE_RANK[implied] <= declared) return null;
  return [
    `Derived signals disagree with the recorded cycle state.`,
    `  Recorded by the caller: ${entry.cycle_state}`,
    `  Derived by the engine from recorded data: ${implied}`,
    ...(entry.signals ?? []).map((signal) => `  - ${signal.code}: ${signal.observed}`),
    `The recorded cycle state was NOT changed. Plangonaut does not overwrite a person's judgement and does not accept it in silence either; the signals are stored beside it in progress_forecast.signals.`,
  ].join("\n");
}

const FORECAST_RECORD_COMMAND =
  `plangonaut forecast --project-root . --owner NAME --phase TEXT --known-work TEXT --conditional-work TEXT ` +
  `--questions MIN-MAX --operations MIN-MAX --cycles MIN-MAX --confidence ALTA|MEDIA|BASSA ` +
  `--confidence-reason TEXT --cycle-state REGOLARE|IN_ESPANSIONE|RISCHIO_LOOP|BLOCCATO --operation-id OP-ID`;

const FORECAST_NEVER_RECORDED =
  `No progress forecast has ever been recorded for this project. That is not zero remaining work, not a default and not a measurement: nothing was recorded.`;

/** The forecast block shown by `resume`, `context-pack` and any other reader of the pack. */
/**
 * What is left, split by what kind of work it is.
 *
 * The forecast used to count questions, operations and cycles. The pilot's
 * forecast was therefore encouraging: the questions were nearly done. What it
 * could not express is that the entire operational plan — the decomposition,
 * the responsibilities, the acceptance criteria — had not been started, and
 * that no number of remaining interview questions describes that.
 *
 * So the operational work is counted separately and never folded into the
 * question count. A project four questions from the end of its definition and
 * with no plan under it is not four questions from the end.
 */
function operationalRemainder(state: State): Record<string, unknown> {
  const readiness = readinessReport(state);
  const tasks = state.tasks ?? [];
  const requirements = state.requirements ?? [];
  const covered = new Set<string>();
  for (const task of tasks) for (const id of task.requirements ?? []) covered.add(String(id).toUpperCase());
  const approved = new Set(["ACTIVE", "CONFIRMED", "APPROVED"]);

  const modules = state.modules ?? [];
  const operationalModules = [14, 15].filter((id) => {
    const module = modules.find((item: any) => item.id === id);
    return module !== undefined && !MODULE_SETTLED.has(String(module.status).toUpperCase());
  });
  const definitionModules = DEFINITION_MODULES.filter((id) => {
    const module = modules.find((item: any) => item.id === id);
    return module !== undefined && !MODULE_SETTLED.has(String(module.status).toUpperCase());
  });

  return {
    definition_modules_open: definitionModules,
    operational_modules_open: operationalModules,
    requirements_without_task: requirements.filter(
      (requirement) => approved.has(String(requirement.status).toUpperCase()) && !covered.has(String(requirement.id).toUpperCase())
    ).length,
    tasks_without_acceptance: tasks.filter((task) => !nonEmpty(task.acceptance)).length,
    tasks_without_evidence: tasks.filter((task) => !nonEmpty(task.verification) && !nonEmpty(task.evidence_expected)).length,
    organization_decided: Boolean(state.execution_organization),
    execution_intent: readiness.intent === "UNDECLARED" ? "NOT DECLARED" : readiness.intent === "NO" ? "DEFINITION_ONLY" : "EXECUTION",
    definition_readiness: readiness.definition.verdict,
    execution_readiness: readiness.execution.verdict,
  };
}

/** The same split, in the words a person reads. */
function operationalRemainderLines(state: State): string[] {
  const remainder = operationalRemainder(state) as any;
  const lines = [
    "",
    "## What is left, by kind",
    "",
    `- Definition modules still open: ${remainder.definition_modules_open.length ? remainder.definition_modules_open.join(", ") : "none"}`,
    `- Operational modules still open (14, 15): ${remainder.operational_modules_open.length ? remainder.operational_modules_open.join(", ") : "none"}`,
    `- Approved requirements with no task: ${remainder.requirements_without_task}`,
    `- Tasks with no acceptance criterion: ${remainder.tasks_without_acceptance}`,
    `- Tasks with no verification or evidence: ${remainder.tasks_without_evidence}`,
    `- Organisation of executors approved: ${remainder.organization_decided ? "yes" : "no"}`,
    `- Definition: ${remainder.definition_readiness}`,
    `- Execution readiness: ${remainder.execution_readiness}`,
  ];
  if (remainder.execution_readiness === "FAILED" || remainder.execution_readiness === "NOT ASSESSED") {
    lines.push(
      "",
      `The end is not near while this list is not empty, whatever the question count above says:`,
      `a project can be four questions from the end of its definition and have no plan under it at all.`,
    );
  }
  return lines;
}

function forecastMarkdown(state: State, historyEntries = 0): string[] {
  const entry = state.progress_forecast;
  const lines = ["## Progress forecast", ""];
  if (!entry) {
    lines.push(`- ${FORECAST_NEVER_RECORDED}`, `- Record one with: ${FORECAST_RECORD_COMMAND}`, "");
    // Even with no recorded forecast, the operational remainder is countable
    // from the ledger, and it is the half the pilot needed.
    lines.push(...operationalRemainderLines(state), "");
    return lines;
  }
  lines.push(
    `- Phase: ${entry.phase}`,
    `- Known work remaining: ${entry.known_work}`,
    `- Conditional work: ${entry.conditional_work}`,
    `- Questions: ${forecastRangeText(entry.questions)}`,
    `- Operations: ${forecastRangeText(entry.operations)}`,
    `- Cycles: ${forecastRangeText(entry.cycles)}`,
    `- Confidence: ${entry.confidence} — ${entry.confidence_reason}`,
    `- Cycle state, as recorded by the caller: ${entry.cycle_state}`,
    `- Recorded by ${entry.recorded_by} at ${entry.recorded_at}, state revision ${entry.state_revision}`,
    `- These numbers are ${entry.authored_by === "agent" ? "**an agent's estimate**, not a commitment anyone made" : entry.authored_by === "human" ? "**a person's commitment**" : "of unrecorded authorship: this project predates the distinction, so whether they are an estimate or an undertaking is not known"}`,
    `- Why it changed: ${entry.change_reason ?? "first forecast recorded for this project"}`,
    `- Counted by the engine from the ledgers: open blockers ${entry.derived.open_blockers}${blockerZeroCaveat(state, entry.derived.open_blockers)}, open overrides ${entry.derived.open_overrides}, gates remaining ${entry.derived.gates_remaining}, unresolved modules ${entry.derived.unresolved_modules.length}, open findings ${entry.derived.open_findings ?? 0}, tasks ${TASK_STATUSES.map((status) => `${status} ${entry.derived.tasks_by_status?.[status] ?? 0}`).join(", ")}`
  );
  if ((entry.signals ?? []).length) {
    lines.push("- Derived loop signals:");
    for (const signal of entry.signals) lines.push(`  - ${signal.code} (implies ${signal.implies_cycle_state}): ${signal.observed}`);
  } else {
    lines.push("- Derived loop signals: none in the recorded data.");
  }
  lines.push(...operationalRemainderLines(state));
  if (!entry.derived.status_history_events && ((state.tasks ?? []).length || (state.risks ?? []).length)) {
    lines.push(
      `- Reopening signals are not observable in this project: no ledger event recorded the status of the record it changed, so the engine cannot see whether a task or risk returned to an earlier status. Absence of that signal here is not evidence of absence.`
    );
  }
  const disagreement = forecastDisagreement(entry);
  if (disagreement) lines.push("", ...disagreement.split("\n"));
  lines.push("");
  if (historyEntries > 0) {
    const history = (state.forecast_history ?? []).slice(-historyEntries).reverse();
    lines.push("## Progress forecast history", "");
    if (!history.length) lines.push("- No previous forecast; the current one is the first.");
    for (const item of history) {
      lines.push(
        `- ${item.recorded_at} (revision ${item.state_revision}, ${item.recorded_by}): ${item.phase} — ${item.cycle_state}, confidence ${item.confidence}, questions ${forecastRangeText(item.questions)}, operations ${forecastRangeText(item.operations)}, cycles ${forecastRangeText(item.cycles)} — ${item.change_reason ?? "first forecast recorded for this project"}`
      );
    }
    lines.push("");
  }
  return lines;
}

/** Structural validation of one stored entry. Runs on every mutation, via `stateErrors`. */
function forecastEntryErrors(entry: any, label: string): string[] {
  const errors: string[] = [];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [`${label} must be an object`];
  for (const key of ["phase", "known_work", "conditional_work", "confidence_reason", "recorded_by", "recorded_at"]) {
    if (!nonEmpty(entry[key])) errors.push(`${label}.${key} is required`);
  }
  for (const key of ["questions", "operations", "cycles"]) {
    const range = entry[key];
    if (!range || typeof range !== "object" || !Number.isInteger(range.min) || !Number.isInteger(range.max) || range.min < 0 || range.max < range.min) {
      errors.push(`${label}.${key} must be a range {min,max} of non-negative integers with min <= max`);
    }
  }
  if (!CONFIDENCE_LEVELS.includes(entry.confidence)) errors.push(`${label}.confidence must be one of ${CONFIDENCE_LEVELS.join(", ")}`);
  if (!CYCLE_STATES.includes(entry.cycle_state)) errors.push(`${label}.cycle_state must be one of ${CYCLE_STATES.join(", ")}`);
  if (entry.change_reason !== null && !nonEmpty(entry.change_reason)) errors.push(`${label}.change_reason must be a non-empty string or null`);
  if (!Number.isInteger(entry.state_revision) || entry.state_revision < 1) errors.push(`${label}.state_revision must be a positive integer`);
  if (!entry.derived || typeof entry.derived !== "object" || Array.isArray(entry.derived)) errors.push(`${label}.derived must be an object`);
  if (!Array.isArray(entry.signals)) errors.push(`${label}.signals must be an array`);
  // Stated as a rule and not only as an absent field: nothing in a forecast may be
  // a percentage.
  for (const key of Object.keys(entry)) {
    if (/percent|percentage|progress_pct|pct$/i.test(key)) errors.push(`${label}.${key} stores a percentage, which a forecast may never carry`);
  }
  return errors;
}

function stateErrors(root: string, state: State, pendingEvent?: any): string[] {
  const errors: string[] = [];
  // A refusal that names the remedy, because this one is reached by opening an
  // older project — the moment somebody most needs to be told what to do, and
  // the moment `unsupported schema_version=2` told them least.
  if (state.schema_version !== SCHEMA_VERSION)
    errors.push(
      `unsupported schema_version=${state.schema_version}: this engine (${VERSION}) writes schema ${SCHEMA_VERSION}. ` +
      `The project needs migrating before it can be read: plangonaut migrate --project-root . --operation-id <id>. ` +
      `Nothing has been changed.`
    );
  // A refusal that blocks every command has to say what unblocks it. See the
  // matching message in `docop.rs`: both implementations say the same thing.
  if (state.project?.root !== root)
    errors.push(
      `project root does not match requested root: the ledger records ${state.project?.root ?? "<nothing>"} and this is ${root}. A Plangonaut project is not portable by copying — the recorded root is checked before every command. Re-root it with: plangonaut project-export --project-root <original> --output-dir <package>, then plangonaut project-import --package-dir <package> --project-root <destination>. This is the tool being unusable here, not the project state being broken: nothing in the folder is damaged.`
    );
  if (!PROJECT_MODES.has(state.project?.mode)) errors.push(`unsupported project mode=${state.project?.mode}`);
  if (!INTERACTION_MODES.has(state.interaction_mode)) errors.push(`unsupported interaction mode=${state.interaction_mode}`);
  if (!LIFECYCLE_STATES.has(state.lifecycle_state)) errors.push(`unsupported lifecycle state=${state.lifecycle_state}`);
  
  if (!Array.isArray(state.modules) || state.modules.map((item) => item.id).join(",") !== Array.from({ length: 17 }, (_, index) => index).join(",")) errors.push("modules must contain ordered IDs 0..16");
  else if (state.modules.some((item) => !MODULE_STATUSES.has(item.status))) errors.push("invalid module status");
  
  if (!state.decision_owners || Object.keys(state.decision_owners).sort().join(",") !== OWNER_KEYS.slice().sort().join(",")) errors.push("decision owners are incomplete or contain unknown keys");
  if (!Array.isArray(state.human_overrides)) errors.push("human_overrides must be an array");
  else {
    if (state.human_overrides.some((item) => !item.id || !new Set(["OPEN", "RECONCILED"]).has(item.status))) errors.push("invalid human override");
    if (Boolean(state.needs_reconciliation) !== state.human_overrides.some((item) => item.status === "OPEN")) errors.push("needs_reconciliation does not match open overrides");
  }

  // Validate v3 ledgers
  if (!Array.isArray(state.decisions)) errors.push("decisions must be an array");
  if (!Array.isArray(state.requirements)) errors.push("requirements must be an array");
  if (!Array.isArray(state.artifacts)) errors.push("artifacts must be an array");
  if (!Array.isArray(state.tasks)) errors.push("tasks must be an array");
  if (!Array.isArray(state.dependencies)) errors.push("dependencies must be an array");
  if (!Array.isArray(state.gates)) errors.push("gates must be an array");
  if (!Array.isArray(state.risks)) errors.push("risks must be an array");
  if (!Array.isArray(state.evidence)) errors.push("evidence must be an array");
  if (!Array.isArray(state.agents)) errors.push("agents must be an array");
  if (!Array.isArray(state.operations)) errors.push("operations must be an array");
  if (!Array.isArray(state.checkpoints)) errors.push("checkpoints must be an array");

  const ledgers = [state.decisions, state.requirements, state.artifacts, state.tasks, state.dependencies, state.gates, state.risks, state.evidence, state.agents, state.operations, state.checkpoints].filter(Array.isArray) as any[][];
  const duplicates = duplicateIds(ledgers.flat());
  if (duplicates.length) errors.push(`duplicate ledger IDs: ${duplicates.join(", ")}`);

  const validateRevision = (item: any, label: string) => {
    if (!Number.isInteger(item?.revision) || item.revision < 1) errors.push(`${label} ${item?.id ?? "<missing>"} has invalid revision`);
    if (!nonEmpty(item?.owner)) errors.push(`${label} ${item?.id ?? "<missing>"} has no owner`);
    if (!nonEmpty(item?.updated_at)) errors.push(`${label} ${item?.id ?? "<missing>"} has no updated_at`);
  };
  for (const item of state.decisions ?? []) {
    if (!validTypedId(item.id, "DEC") || !nonEmpty(item.title) || !LEDGER_RULES.decision.statuses!.has(item.status)) errors.push(`invalid decision ${item?.id ?? "<missing>"}`);
    validateRevision(item, "decision");
  }
  for (const item of state.requirements ?? []) {
    if (!validTypedId(item.id, "REQ") || !nonEmpty(item.title) || !LEDGER_RULES.requirement.statuses!.has(item.status)) errors.push(`invalid requirement ${item?.id ?? "<missing>"}`);
    validateRevision(item, "requirement");
  }
  for (const item of state.tasks ?? []) {
    if (!validTypedId(item.id, "TSK") || !nonEmpty(item.title) || !LEDGER_RULES.task.statuses!.has(item.status)) errors.push(`invalid task ${item?.id ?? "<missing>"}`);
    validateRevision(item, "task");
  }
  for (const item of state.dependencies ?? []) {
    if (!validTypedId(item.id, "DEP") || !nonEmpty(item.from) || !nonEmpty(item.to) || !LEDGER_RULES.dependency.statuses!.has(item.type)) errors.push(`invalid dependency ${item?.id ?? "<missing>"}`);
    validateRevision(item, "dependency");
  }
  for (const item of state.risks ?? []) {
    if (!validTypedId(item.id, "RSK") || !nonEmpty(item.title) || !new Set(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).has(item.severity) || !LEDGER_RULES.risk.statuses!.has(item.status)) errors.push(`invalid risk ${item?.id ?? "<missing>"}`);
    validateRevision(item, "risk");
  }
  for (const item of state.evidence ?? []) {
    if (!validTypedId(item.id, "EVD") || !safeArtifactPath(item.path) || !/^[a-f0-9]{64}$/.test(item.sha256 ?? "")) errors.push(`invalid evidence ${item?.id ?? "<missing>"}`);
    validateRevision(item, "evidence");
    if (safeArtifactPath(item.path)) {
      const evidenceFile = existingFileInside(root, item.path);
      if (!evidenceFile) errors.push(`evidence ${item.id} file is missing or escapes the project root`);
      // This one check refuses every mutation, not just the one that caused it:
      // it runs inside `commitState`. An ALN-005 pilot hit it by legitimately
      // correcting an evidence file and found a project that answered
      // "hash does not match" to everything and named no way out. The route
      // exists — re-record the evidence at its current revision — so the
      // refusal now states it. Both implementations must produce this string
      // byte for byte; see `docop.rs`.
      else if (sha256(fs.readFileSync(evidenceFile)) !== item.sha256) errors.push(`evidence ${item.id} no longer matches ${item.path}: re-record it with \`plangonaut evidence --id ${item.id} --file ${item.path} --owner <owner> --expected-revision ${Number.isInteger((item as any).revision) ? (item as any).revision : "?"}\`. Until then every mutation is refused, because this check runs inside the transaction.`);
    }
  }
  for (const item of state.agents ?? []) {
    if (!validTypedId(item.id, "AGT") || !nonEmpty(item.name) || !LEDGER_RULES.agent.statuses!.has(item.status)) errors.push(`invalid agent ${item?.id ?? "<missing>"}`);
    validateRevision(item, "agent");
  }
  for (const item of state.checkpoints ?? []) {
    if (!validTypedId(item.id, "CHK") || !nonEmpty(item.name) || !nonEmpty(item.created_at)) errors.push(`invalid checkpoint ${item?.id ?? "<missing>"}`);
    validateRevision(item, "checkpoint");
  }
  /*
   * Blockers, in both shapes, and neither of them is an error.
   *
   * A plain string is a blocker somebody wrote into the state file before this
   * ledger existed. It is valid and it stays valid: refusing it would make every
   * project that has one unopenable, and rewriting it into a record would mean
   * inventing an owner and a date it never had. A *record* is held to the same
   * standard as every other ledger entry.
   */
  const seenBlockerIds = new Set<string>();
  for (const item of blockerEntries(state)) {
    if (typeof item === "string") {
      if (!item.trim()) errors.push("blocker recorded as an empty string");
      continue;
    }
    if (
      !validTypedId((item as any)?.id, "BLK") ||
      !nonEmpty((item as any)?.title) ||
      !nonEmpty((item as any)?.reason) ||
      !nonEmpty((item as any)?.owner) ||
      !nonEmpty((item as any)?.recorded_at) ||
      !BLOCKER_STATUSES.has((item as any)?.status)
    ) {
      errors.push(`invalid blocker ${(item as any)?.id ?? "<missing>"}`);
      continue;
    }
    if (seenBlockerIds.has(item.id)) errors.push(`blocker ${item.id} is recorded twice`);
    seenBlockerIds.add(item.id);
    // A resolved blocker that does not say how, when or by whom is a record of
    // nothing: the point of keeping it is the account of how it ended.
    if (item.status === "RESOLVED" && !(nonEmpty(item.resolution) && nonEmpty(item.resolved_by) && nonEmpty(item.resolved_at))) {
      errors.push(`blocker ${item.id} is RESOLVED without a resolution, an owner and an instant`);
    }
    validateRevision(item, "blocker");
  }
  const verification = state.blockers_none_verified;
  if (verification !== undefined && verification !== null) {
    if (!nonEmpty(verification.by) || !nonEmpty(verification.at) || !Number.isInteger(verification.state_revision)) {
      errors.push("blockers_none_verified is present but does not record who verified, when, and against which revision");
    } else if (openBlockers(state).length) {
      // The two cannot both be true, and a state file asserting both is exactly
      // the case `UNTRUSTED` exists for.
      errors.push(`blockers_none_verified says no blocker is open, and ${openBlockers(state).length} are`);
    }
  }
  for (const item of state.artifacts ?? []) {
    if (!validTypedId(item.id, "ART") || !safeArtifactPath(item.base_path) || !safeArtifactPath(item.working_path) || !new Set(["DRAFT", "PUBLISHED", "DEPRECATED"]).has(item.status) || !Number.isInteger(item.revision) || item.revision < 1 || !/^[a-f0-9]{64}$/.test(item.content_hash ?? "")) errors.push(`invalid artifact ${item?.id ?? "<missing>"}`);
  }
  const duplicateBasePaths = duplicateIds((state.artifacts ?? []).map((item) => ({ id: item.base_path.toLowerCase() })));
  if (duplicateBasePaths.length) errors.push(`artifact base_path collisions: ${duplicateBasePaths.join(", ")}`);
  const duplicateWorkingPaths = duplicateIds((state.artifacts ?? []).filter((item) => item.working_path).map((item) => ({ id: item.working_path.toLowerCase() })));
  if (duplicateWorkingPaths.length) errors.push(`artifact working_path collisions: ${duplicateWorkingPaths.join(", ")}`);

  if (Array.isArray(state.dependencies)) {
    const nodes = new Set([...(state.decisions ?? []), ...(state.requirements ?? []), ...(state.artifacts ?? []), ...(state.tasks ?? []), ...(state.risks ?? []), ...(state.evidence ?? []), ...(state.agents ?? []), ...(state.checkpoints ?? [])].map((item: any) => item.id));
    const allowedProvenance = new Set([...(state.decisions ?? []), ...(state.evidence ?? [])].map((item: any) => item.id));
    for (const artifact of state.artifacts ?? []) {
      if (!Array.isArray(artifact.provenance) || artifact.provenance.some((source: unknown) => !nonEmpty(source) || !allowedProvenance.has(String(source)))) errors.push(`artifact ${artifact.id} has invalid or dangling provenance; sources must reference DEC/EVD records`);
    }
    for (const dep of state.dependencies) {
      if (!nodes.has(dep.from)) errors.push(`dependency ${dep.id} has missing from node ${dep.from}`);
      if (!nodes.has(dep.to)) errors.push(`dependency ${dep.id} has missing to node ${dep.to}`);
      if (dep.from === dep.to) errors.push(`dependency ${dep.id} cannot reference the same node twice`);
    }
    const cycleErrors = detectCycles(state.dependencies);
    errors.push(...cycleErrors);
  }

  // Both fields are optional: a project that never recorded a forecast is valid,
  // and the two ALN-005 pilots are exactly that project. Present means checked.
  if (state.progress_forecast !== undefined) errors.push(...forecastEntryErrors(state.progress_forecast, "progress_forecast"));
  if (state.forecast_history !== undefined) {
    if (!Array.isArray(state.forecast_history)) errors.push("forecast_history must be an array");
    else state.forecast_history.forEach((entry, index) => errors.push(...forecastEntryErrors(entry, `forecast_history[${index}]`)));
  }
  if (state.progress_forecast === undefined && (state.forecast_history ?? []).length) {
    errors.push("forecast_history holds entries while progress_forecast is unset; the current forecast cannot be missing from a project that recorded one");
  }

  // The interview ledger is optional: a project created before it existed is
  // valid and carries none. Present means checked, in full.
  if (state.interview_log !== undefined) errors.push(...interviewLogErrors(root, state));

  const events = path.join(stateRoot(root), "events.jsonl");
  let parsed: any[] = [];
  if (!fs.existsSync(events) && !pendingEvent) errors.push("events.jsonl is missing");
  else if (fs.existsSync(events)) {
    const ids = new Set<string>();
    let priorAt = "";
    let priorRevision = 0;
    for (const [index, line] of fs.readFileSync(events, "utf8").split(/\r?\n/).filter(Boolean).entries()) {
      try {
        const event = JSON.parse(line);
        if (!event.event_id || !event.type) errors.push(`invalid event at line ${index + 1}`);
        else {
          parsed.push(event);
          if (ids.has(event.event_id)) errors.push(`duplicate event_id at line ${index + 1}`);
          ids.add(event.event_id);
          if (priorAt && event.at && event.at < priorAt) errors.push(`event at line ${index + 1} is out of chronological order`);
          priorAt = event.at || priorAt;
          if (event.state_revision !== undefined) {
            if (!Number.isInteger(event.state_revision) || event.state_revision <= priorRevision) errors.push(`invalid state_revision at line ${index + 1}`);
            else priorRevision = event.state_revision;
          }
        }
      } catch {
        errors.push(`invalid JSON event at line ${index + 1}`);
      }
    }
  }
  
  if (pendingEvent) parsed.push(pendingEvent);
  
  if (!Number.isInteger(state.revision) || state.revision < 1) errors.push("revision must be a positive integer");
  if (!state.last_event_id) errors.push("last_event_id is required");
  if (!parsed.length) errors.push("events.jsonl must contain at least one event");
  else {
    const latest = parsed.at(-1);
    if (latest.event_id !== state.last_event_id) errors.push("last_event_id does not match the latest event");
    if (latest.state_revision !== state.revision) errors.push("state revision does not match the latest event");
  }
  return errors;
}

function contextMarkdown(state: State, forecastHistoryEntries = 0): string {
  const active = activeModule(state);
  const lines = [
    "# Plangonaut Context Pack", "",
    `- Project: ${state.project.name}`,
    `- Mode: ${state.project.mode}`,
    `- Lifecycle: ${state.lifecycle_state}`,
    `- Gate: ${state.current_gate}`,
    /*
     * The three states, at the top of the pack.
     *
     * The context pack is what a recipient reads first and sometimes only, so a
     * folder that is not an execution package has to say so here rather than
     * twenty lines down. The pilot's pack read as a finished project because
     * nothing in it distinguished a settled definition from a plan.
     */
    ...(() => {
      const report = readinessReport(state);
      const lines = [
        `- Execution intent: ${report.intent === "UNDECLARED" ? "NOT DECLARED — nobody has said whether this is to be built" : report.intent === "NO" ? "DEFINITION_ONLY" : "EXECUTION"}`,
        `- Definition: ${report.definition.verdict === "PASSED" ? "substantially complete" : "incomplete"}`,
        `- Execution readiness: ${report.execution.verdict}`,
      ];
      if (report.intent === "NO") {
        lines.push(`- This folder is not an execution package, and is not meant to be one.`);
      } else if (report.execution.verdict === "FAILED") {
        lines.push(`- ${report.execution.findings.length} thing${report.execution.findings.length === 1 ? "" : "s"} stop${report.execution.findings.length === 1 ? "s" : ""} anybody from starting; plangonaut execution-readiness --project-root . lists them.`);
      }
      return lines;
    })(),
    `- Interaction: ${state.interaction_mode}`,
    // Here rather than further down, because this is read instead of the
    // conversation the preference was stated in. A fresh agent that misses this
    // line asks five questions at somebody who said three.
    (() => {
      const block = questionBlockSize(state);
      return `- Question block: ${block.effective}${block.recorded ? "" : " (nobody has set one; this is the default)"}`;
    })(),
    `- Exact next action: ${state.exact_next_action}`, "",
    // Which engine produced what follows, before anything that follows.
    //
    // The context pack is what a fresh agent reads instead of the conversation,
    // and "which Plangonaut wrote this" is the first thing it cannot afford to
    // guess. A pilot was attributed to the wrong release because this was
    // nowhere: the reader had the whole folder and still could not say which
    // engine had done the work without opening `state.json` by hand.
    "## Versions", "",
    ...provenanceLines(state), "",
    // Deliberately next to status and the next action, and above everything else:
    // resume is what a fresh agent reads instead of the chat, so a forecast it
    // cannot see does not exist.
    ...forecastMarkdown(state, forecastHistoryEntries),
    "## Decision owners", "",
    ...OWNER_KEYS.map((key) => `- ${key}: ${state.decision_owners[key]}`), "",
    "## Gates", "",
    ...((state.gates ?? []).length ? (state.gates ?? []).map((item) => `- ${item.name || item.id}: ${item.status}`) : ["- None passed yet."]), "",
    "## Active module", "",
    active ? `- ${active.id} — ${active.title} [${active.status}]` : "- None; questionnaire coverage is complete.", "",
    "## Coverage evidence", "",
    ...state.modules.filter((item) => item.status !== "NOT STARTED").flatMap((item) => [`- M${item.id}: ${item.status} — ${item.evidence || "not recorded"}`, ...(item.summary ? [`  Summary: ${item.summary}`] : [])]), "",
    "## Blockers", "",
    // Open first, then the resolved ones, which stay. An empty list is still not
    // evidence of none: what makes a zero mean something is somebody recording
    // that they looked, and the section says which of the two this is.
    ...blockerReportLines(state), "",
    "## Risks", "",
    ...(state.risks?.length ? state.risks.map((item) => `- ${item.title}`) : ["- None recorded."]), "",
    "## Authoritative evidence", "",
    ...(state.evidence?.length ? state.evidence.map((item) => `- ${item.path}`) : ["- None recorded in state; inspect canonical project sources."]), "",
    "## Human overrides", "",
    ...((state.human_overrides ?? []).filter((item) => item.status === "OPEN").map((item) => `- ${item.id}: OPEN — ${item.summary || item.source}`).length ? (state.human_overrides ?? []).filter((item) => item.status === "OPEN").map((item) => `- ${item.id}: OPEN — ${item.summary || item.source}`) : ["- None open."]), "",
    "Read canonical project sources before acting; this pack is operational state, not product truth.", ""
  ];
  return lines.join("\n");
}

/**
 * What this engine is, and what its commands take.
 *
 * It used to answer the first half only: a version, a schema number, three
 * lists of modes. An agent instructed to run this before its first mutation
 * learned nothing about the grammar and invented `plangonaut coverage` — which
 * is not a failure of the instruction, it is the instruction being impossible
 * to follow.
 *
 * `commands` is generated from the same tables the parser uses, so it cannot
 * describe a command surface that does not exist.
 */
function capabilities(): void {
  const commands: Record<string, unknown> = {};
  for (const name of Object.keys(COMMAND_OPTIONS).sort()) {
    const grammar = COMMAND_GRAMMAR[name];
    const requiredOptions = grammar?.required ?? [];
    commands[name] = {
      summary: grammar?.summary ?? null,
      options: COMMAND_OPTIONS[name],
      required: requiredOptions,
      optional: COMMAND_OPTIONS[name].filter((option) => !requiredOptions.includes(option)),
      values: grammar?.values ?? {},
      mutating: COMMAND_OPTIONS[name].includes("operation-id") && name !== "migrate-brand",
      example: grammar?.example ?? null,
      note: grammar?.note ?? null,
    };
  }
  console.log(JSON.stringify({
    beave_version: VERSION,
    schema_version: SCHEMA_VERSION,
    node: process.versions.node,
    node_supported: Number(process.versions.node.split(".")[0]) >= 20,
    external_dependencies: [],
    network_required: false,
    profiles: ["Hybrid", "Semantic-only"],
    project_modes: [...PROJECT_MODES].sort(),
    interaction_modes: ["Guided", "Standard", "Expert"],
    /*
     * Said in the payload as well as in the table, because an agent reads the
     * top of a JSON document and acts. Every one of these was a real mistake.
     */
    grammar_notes: [
      "Every option a command accepts is listed under commands.<name>.options. An option not listed is refused, not ignored.",
      "One command, one mutation. Do not chain mutations with ; or && : read each result before the next.",
      "Every mutating command needs a unique, stable --operation-id. A retry of the same operation reuses it; a different operation must not.",
      "Requirement-task coverage is recorded with dependency, one requirement to one task per command. There is no coverage command.",
      "plangonaut <command> --help prints this command's options, accepted values and one correct example.",
    ],
    commands,
  }, null, 2));
}

function init(flags: Flags): void {
  const root = resolveProject(required(flags, "project-root"));
  recoverFileTransactions(root);
  const destination = stateRoot(root);
  const key = idempotencyKey(flags);
  if (fs.existsSync(path.join(destination, "events.jsonl")) && checkIdempotency(root, key)) return console.log(`Idempotent retry: init already applied.`);
  if (fs.existsSync(path.join(destination, "state.json")) || fs.existsSync(path.join(destination, "events.jsonl"))) throw new PlangonautError(`State already exists at ${destination}; use resume`);
  const projectMode = required(flags, "project-mode");
  const interactionMode = required(flags, "interaction-mode");
  if (!PROJECT_MODES.has(projectMode)) throw new PlangonautError(`Unsupported project mode: ${projectMode}`);
  if (!INTERACTION_MODES.has(interactionMode)) throw new PlangonautError(`Unsupported interaction mode: ${interactionMode}`);
  const owners = readJson(path.resolve(required(flags, "owners-file")));
  // Schema v3 closes `decision_owners` to exactly five roles, so a sixth cannot be
  // stored. It used to be dropped in silence: pilot B supplied `compliance` and
  // `quality` for a CE-marked product and `init` reported success without them.
  const unknownOwners = Object.keys(owners ?? {}).filter((key) => !OWNER_KEYS.includes(key));
  if (unknownOwners.length) {
    throw new PlangonautError(
      `Owners file declares roles Plangonaut cannot store: ${unknownOwners.join(", ")}. ` +
        `Recognised roles are ${OWNER_KEYS.join(", ")}. Record the other authorities in a governed document and reference them there; nothing was written.`
    );
  }
  for (const key of OWNER_KEYS) if (!String(owners[key] ?? "").trim()) throw new PlangonautError(`Owners file requires ${OWNER_KEYS.join(", ")}`);
  const timestamp = now();
  const eventId = crypto.randomUUID();
  const state: State = {
    schema_version: SCHEMA_VERSION,
    beave_version: VERSION,
    project: { name: required(flags, "project-name"), root, mode: projectMode },
    interaction_mode: interactionMode,
    intake_strategy: "Adaptive",
    decision_owners: Object.fromEntries(OWNER_KEYS.map((key) => [key, String(owners[key]).trim()])),
    lifecycle_state: "INTERVIEW",
    current_gate: "G1",
    modules: questionnaire().map((item: any) => ({ id: item.id, title: item.title, status: item.id === 0 ? "CONFIRMED" : "NOT STARTED", owner: item.id === 0 ? "human authorities" : null, evidence: item.id === 0 ? "Gate G0 init arguments" : null, updated_at: item.id === 0 ? timestamp : null })),
    
    decisions: [],
    requirements: [],
    artifacts: [],
    tasks: [],
    dependencies: [],
    gates: [],
    risks: [],
    evidence: [],
    agents: [],
    operations: [],
    checkpoints: [],

    blockers: [], 
    interview_log: [],
    // A new project records its interview from the first question. The marker
    // matters for the other case: a project that existed before this ledger did,
    // where `migrate` sets it to the migration instant so nothing before that
    // date can be read as "no questions were asked".
    interview_log_since: timestamp,
    interview_view: null,
    /*
     * What this project expects to govern, recorded at the one moment it can be
     * recorded truthfully.
     *
     * `preexisting` is the whole reason this is written at `init` rather than
     * computed later. Plangonaut is entered on empty folders and on repositories
     * with years of documentation in them, and after the fact those two are
     * indistinguishable: every Markdown file is simply there. Listed here, the
     * folder's existing documentation is known to be the folder's, and a file
     * that appears afterwards inside a governed directory is known to be new.
     * Without the list, the only honest signal left is the `-vN` name.
     *
     * `exclusions` is empty and stays empty unless a person writes in it. It is
     * where a deliberate decision not to govern a file is recorded, so that the
     * warning about it stops for a reason instead of being ignored.
     */
    document_governance: {
      directories: [...DEFAULT_GOVERNED_DIRECTORIES],
      exclusions: [],
      preexisting: markdownFiles(root),
    },
    human_overrides: [],
    needs_reconciliation: false,
    revision: 1, 
    last_event_id: eventId,
    exact_next_action: "Run `plangonaut next --project-root .` and discuss module 1.",
    created_at: timestamp, 
    updated_at: timestamp
  };
  /*
   * The history document exists from the first minute, saying that nothing has
   * been asked yet.
   *
   * It was created lazily, on the first `qa-ask`, and a new project therefore had
   * an empty ledger and no document — so "the history is at
   * QUESTION_ANSWER_HISTORY.md" was a promise that came true later. A reader
   * opening the folder finds a file that tells them what it is, or they find
   * nothing and conclude there is nothing to find.
   */
  const initialView = stampInterviewView(state);
  /*
   * `replay_origin` is what makes a new project reproducible from nothing.
   *
   * This event's patch sets the whole state, so replaying from here needs no
   * earlier history and no separate snapshot file: initialization *is* the
   * baseline. An imported or migrated project gets one the other way round, from
   * `plangonaut baseline`, and says so.
   */
  const event = { event_id: eventId, type: "PROJECT_INITIALIZED", state_revision: 1, at: timestamp, project: state.project.name, project_mode: projectMode, interaction_mode: interactionMode, idempotency_key: key, replay_origin: true, operation_id: pendingOperation!.id, operation_payload_hash: pendingOperation!.payloadHash, operation_payload_version: pendingOperation!.payloadVersion };
  const errors = stateErrors(root, state, event);
  if (errors.length) throw new PlangonautError(`Initialization failed validation:\n- ${errors.join("\n- ")}`);
  fs.mkdirSync(destination, { recursive: true });
  const transaction = beginFileTransaction(root, event, [path.join(root, QA_VIEW_RELATIVE)]);
  try {
    /*
     * `views: true`, like every other command that writes a derived document.
     *
     * Without it the journal recorded `regenerate_views: false`, so a recovery
     * rolled the state forward and skipped the document — and `init` writes the
     * document *after* `commitState`. A project interrupted past the point of no
     * return came back with a state recording the digest of a file that was not
     * there: `init`, `status`, `recover` and `replay` all reported success and
     * only `validate` refused. Found by the second independent review; `migrate`
     * and the `qa-*` commands were passing it and this one was not.
     */
    commitState(root, path.join(destination, "state.json"), state, event, { views: true });
    writeInterviewView(root, initialView);
    faultPoint("after-view");
    completeFileTransaction(transaction);
  } catch (error) {
    if (fs.existsSync(transaction)) rollbackFileTransaction(root, transaction);
    throw error;
  }
  const ignored = ensureGitignoreEntries(root);
  console.log(`Initialized Plangonaut state at ${destination}`);
  if (ignored.length) {
    console.log(`\nAdded to .gitignore: ${ignored.join(", ")}`);
    console.log(`Only those two. The state, the events, the interview history and the evidence are deliberately not ignored — they are the project's record and they travel with it.`);
  }
}

/**
 * The two Plangonaut paths a repository should not carry, and no others.
 *
 * `backups/` holds recoverable copies of files whose current version is already
 * tracked, and `lock.json` names a process on one machine. Everything else the
 * ledger writes — `state.json`, `events.jsonl`, the interview history, the
 * evidence — is the record the folder exists to carry, and ignoring any of it
 * would defeat the product. An existing `.gitignore` is appended to, never
 * rewritten, and a line already present is not added twice.
 */
function ensureGitignoreEntries(root: string): string[] {
  const wanted = [`${STATE_DIR}/backups/`, `${STATE_DIR}/lock.json`];
  const location = path.join(root, ".gitignore");
  let existing = "";
  try {
    existing = fs.readFileSync(location, "utf8");
  } catch {
    existing = "";
  }
  const present = new Set(existing.split(/\r?\n/).map((line) => line.trim()));
  const missing = wanted.filter((entry) => !present.has(entry) && !present.has(entry.replace(/\/$/, "")));
  if (!missing.length) return [];
  const block = [
    `# Plangonaut: recoverable copies and a machine-local lock.`,
    `# The state, events, interview history and evidence are NOT ignored: they are`,
    `# the record this folder exists to carry.`,
    ...missing,
  ].join("\n");
  const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
  const separator = existing ? "\n" : "";
  fs.writeFileSync(location, `${existing}${prefix}${separator}${block}\n`, "utf8");
  return missing;
}

/**
 * Recorded digests that no longer describe the file they point at.
 *
 * `stateErrors()` re-hashes `state.evidence[]` records and `documentIntegrityErrors()`
 * re-hashes artifacts, but `modules[].evidence_sha256` was compared in exactly one
 * place — the gate-2 prerequisite check — and `human_overrides[].source_sha256` in
 * none at all. Gate 2 is unreachable until gate 1 passes, so a project could report
 * "Plangonaut state is valid." for the whole interview while a confirmed module pointed
 * at content that no longer existed (ALN-005, reproduced 2026-09-10).
 *
 * Deliberately NOT part of `stateErrors()`. That runs inside `commitState()` on
 * every mutation, and this drift is *expected* whenever a governed evidence
 * document advances to a new `-vN`: putting it there would refuse every later
 * operation on a project whose answer document was legitimately re-recorded. It
 * belongs to `validate`, which is the command whose whole job is to say whether
 * what is recorded still matches what is on disk.
 */
/**
 * The stand-in a repair command shows when the recorded path cannot be reused.
 *
 * The pilot caught the engine dictating its own defect back: an override
 * recorded against `../../../Users/.../scratchpad/ovr1.txt` was refused, and the
 * refusal's own suggested command carried that same path in `--source-file`. An
 * agent that pastes it re-records the unportable path, `validate` fails again,
 * and `source_history` gains an entry documenting a repair that repaired
 * nothing. It is the one place the engine tells the caller what to type, so it
 * is the one place a wrong suggestion is guaranteed to be followed.
 *
 * A placeholder is used instead of a guess. The engine does not know where the
 * file should live — that is the author's decision — and inventing a plausible
 * destination would be a second way of dictating something untrue. What it does
 * know is that the path has to start inside the project, so the placeholder says
 * that and nothing more. It is deliberately not a valid path: a command that
 * cannot run by accident is better than one that runs and records a guess.
 */
const PORTABLE_SOURCE_PLACEHOLDER = "<path-inside-the-project>";

function recordedDigestErrors(root: string, state: State): string[] {
  const errors: string[] = [];
  const check = (label: string, relative: unknown, digest: unknown, remedy: (source: string) => string) => {
    if (typeof relative !== "string" || !relative.trim()) return;
    if (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) return;
    const file = existingFileInside(root, relative);
    if (!file) {
      // Two different situations arrive here and they need two different
      // instructions. A portable path whose file was deleted is repaired by
      // restoring or replacing that file, so the path is worth showing. A path
      // that was never portable cannot be repaired by pointing at it again.
      const portable = safeArtifactPath(relative);
      errors.push(
        portable
          ? `${label} records evidence at ${relative}, which is missing. Restore the file, or point the record at the file that stands in its place: ${remedy(relative)}`
          : `${label} records evidence at ${relative}, which is outside the folder that travels with the project, so the record cannot be read by whoever receives it. ` +
            `Copy the file into the project first, then re-record against its path relative to the root: ${remedy(PORTABLE_SOURCE_PLACEHOLDER)}`
      );
      return;
    }
    if (sha256(fs.readFileSync(file)) !== digest) {
      errors.push(
        `${label} recorded ${relative} with a digest that no longer matches the file. Re-record it against the current file, or restore the recorded content. To re-record: ${remedy(relative)}`
      );
    }
  };

  for (const item of state.modules ?? []) {
    check(
      `module ${item.id}`,
      item.evidence,
      (item as any).evidence_sha256,
      (source) =>
        `plangonaut record --project-root . --module ${item.id} --status ${item.status?.replaceAll(" ", "_") ?? "<status>"} --owner <owner> --answer-file ${source} --operation-id <id>`
    );
  }
  for (const item of state.human_overrides ?? []) {
    check(
      `override ${item.id}`,
      (item as any).source,
      (item as any).source_sha256,
      (source) =>
        `plangonaut re-record --project-root . --kind override --id ${item.id} --source-file ${source} --owner <owner> --reason "<why the source changed>" --operation-id <id>`
    );
  }
  // B5. A gate is the record that says a phase may end, and its evidence is the
  // only reason to believe it — and it was the one recorded digest nothing ever
  // re-verified outside the gate-2 prerequisite check, which is unreachable until
  // gate 1 has already passed.
  //
  // **The compatibility rule, stated rather than implied.** Only the *live record*
  // in `state.json` is checked, and only when it carries both a path and a 64-hex
  // digest. Two things follow, both deliberate:
  //
  //  - A gate written while the record was still `{id, name, status}` claims
  //    nothing, so nothing is refused. Same shape as L26's "only markers that
  //    recorded an archive are checked for one".
  //  - The `GATE_UPDATED` *events* do carry `evidence_sha256`, so a digest for
  //    those old gates is technically recoverable — and reconstructing one from
  //    history is exactly the L26 mistake repeated. Measured on the two ALN-005
  //    pilots on 2026-09-10: four of the five recorded `GATE_UPDATED` events point
  //    at a digest the file no longer has, and two of those four are *superseded*
  //    outcomes (pilot A's G0, and its first G1 WARN). An event records what was
  //    true when it was written; re-checking it turns every legitimate later
  //    revision of an evidence document into a validation failure.
  //
  // The route out of "claims nothing" is a governed operation, not a silent
  // backfill: `plangonaut re-record --kind gate`. `validate` names the gates that carry
  // no digest without failing on them, so the silence is audible.
  for (const item of state.gates ?? []) {
    check(
      `gate ${item.name || item.id}`,
      (item as any).evidence,
      (item as any).evidence_sha256,
      (source) =>
        `plangonaut re-record --project-root . --kind gate --id ${item.name || item.id} --source-file ${source} --owner <owner> --reason "<why the evidence changed>" --operation-id <id>`
    );
  }

  // A deletion marker whose reason cannot be read is a marker nobody can act on
  // (L26). Reported here rather than in `stateErrors`, on purpose: a lost reason
  // is a documentation loss, and refusing every mutation over it would make the
  // project unusable for a defect that damages nothing.
  const eventsFile = path.join(stateRoot(root), "events.jsonl");
  if (fs.existsSync(eventsFile)) {
    for (const line of fs.readFileSync(eventsFile, "utf8").split(/\r?\n/).filter(Boolean)) {
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event?.type !== "DOCUMENT_DELETION_INTENT_RECORDED") continue;
      // Only markers that recorded an archive are checked for one. A marker
      // written before this rule existed has no archive and never claimed to:
      // reporting those would flood `validate` on every project that predates
      // L26 and say nothing true — the reason was already lost when the rule was
      // introduced, which is why the rule exists.
      if (typeof event.reason_archive_path !== "string" || !event.reason_archive_path) continue;
      const digest = typeof event.reason_sha256 === "string" ? event.reason_sha256 : "";
      if (!/^[a-f0-9]{64}$/.test(digest)) continue;
      const archive = deletionReasonArchive(root, digest);
      const label = `deletion intent ${event.deletion_intent_id ?? "<missing>"}`;
      if (!fs.existsSync(archive.absolute)) {
        errors.push(`${label} records a reason at .beave/${archive.relative}, which is not there. The reason it was removed cannot be read any more.`);
        continue;
      }
      if (sha256(fs.readFileSync(archive.absolute)) !== digest) {
        errors.push(`${label} has an archived reason at .beave/${archive.relative} that no longer matches its recorded digest.`);
      }
    }
  }
  return errors;
}

/**
 * Gate records `validate` has nothing to re-verify, and the sentence that says so.
 *
 * A skip that says nothing is what let B5 live: a project could report
 * "Plangonaut state is valid." while every gate in it rested on a file the engine had
 * never looked at again. The skip is still the right behaviour for a record that
 * predates the rule — see `recordedDigestErrors` — so it is reported instead of
 * enforced. `null` when there is nothing to say.
 */
function unverifiableGateNote(state: State): string | null {
  const gates = state.gates ?? [];
  const unverifiable = gates.filter(
    (item) =>
      !nonEmpty((item as any).evidence) || !/^[a-f0-9]{64}$/.test(String((item as any).evidence_sha256 ?? ""))
  );
  if (!unverifiable.length) return null;
  const names = unverifiable.map((item) => item.name || item.id).join(", ");
  return (
    `${unverifiable.length} of ${gates.length} gate record${gates.length === 1 ? "" : "s"} carr${unverifiable.length === 1 ? "ies" : "y"} no evidence digest, so validate re-verified nothing for them: ${names}. ` +
    `They were recorded before the gate record kept its evidence; failing them would report a drift nobody can prove. ` +
    `Attach the file the gate was passed on with: plangonaut re-record --project-root . --kind gate --id ${unverifiable[0].name || unverifiable[0].id} --source-file <file> --owner <owner> --reason "<why>" --operation-id <id>`
  );
}

/**
 * Re-point a recorded source at the file that supersedes it — `OD-012`, option 1.
 *
 * The refusal in `recordedDigestErrors` has always named a remedy — "re-record it
 * against the current file" — that no command performed. `override` only ever
 * creates a *new* override, and the other route the message offered, restoring
 * the recorded bytes, discards a revision somebody wanted. This repository's own
 * project sat refused on exactly that: `OVR-48a5f5aa37aa` recorded the D4 decision
 * document on 2026-09-09, the document was legitimately revised on 2026-09-10.
 *
 * **Why this option and not the other two OD-012 listed.** Snapshotting an
 * override's source into the governed area at record time, as L26 does for
 * deletion reasons, is right for a one-shot rationale and wrong here: an override
 * points at a *living* governed document, and comparing a private copy with
 * itself would make the check pass by construction and stop meaning anything.
 * Declaring the source informational and dropping the check throws away the only
 * mechanism that noticed a real drift on a real project.
 *
 * What it does and does not do:
 *
 *  - it never edits a stored digest; the new one is computed from the file's bytes;
 *  - the previous path and digest, the authority, the reason and the event are all
 *    kept — on the record in `source_history`, and in `RECORDED_SOURCE_UPDATED`;
 *  - it changes provenance only. It cannot change a gate's status, pass anything,
 *    reopen anything, or move the lifecycle.
 *
 * It is deliberately NOT behind `assertNotBlocked`. Reconciliation blocks work
 * that moves the project forward; this is a repair, and an OPEN override whose own
 * source drifted could otherwise never be corrected — the block would be the thing
 * preventing its own removal.
 */
function reRecord(flags: Flags): void {
  const root = resolveProject(required(flags, "project-root"));
  const key = idempotencyKey(flags);
  if (checkIdempotency(root, key)) return console.log(`Idempotent retry: re-record already applied.`);
  const { location, state } = loadState(root);
  const kind = required(flags, "kind").trim().toLowerCase();
  if (kind !== "override" && kind !== "gate") {
    throw new PlangonautError(
      `Unsupported --kind: ${required(flags, "kind")}. Plangonaut can re-record the source of an override or the evidence of a gate. Nothing was written.`
    );
  }
  const owner = required(flags, "owner").trim();
  assertKnownOwner(state, owner);
  const reason = required(flags, "reason").trim();
  if (!reason) {
    throw new PlangonautError(
      `--reason cannot be empty. Re-recording replaces the file a governed record stands on, and the reason is the only account of why it was allowed. Nothing was written.`
    );
  }
  const id = required(flags, "id").trim();

  let label: string;
  let target: any;
  let previousPath: string | null;
  let previousDigest: string | null;
  let relative: string;
  let digest: string;

  if (kind === "override") {
    target = (state.human_overrides ?? []).find((item) => item.id === id);
    if (!target) throw new PlangonautError(`Override not found: ${id}. Nothing was written.`);
    label = `override ${target.id}`;
    previousPath = nonEmpty(target.source) ? String(target.source) : null;
    previousDigest = /^[a-f0-9]{64}$/.test(String(target.source_sha256 ?? "")) ? String(target.source_sha256) : null;
    // An override's source may live under `.beave/`: several on this repository do,
    // and `recordedDigestErrors` re-reads them there. So containment inside the
    // project root is required and the artifact rule is not.
    const sourcePath = path.resolve(required(flags, "source-file"));
    const candidate = path.relative(root, sourcePath);
    const confined = existingFileInside(root, candidate);
    if (!confined) {
      // The one place the engine tells the caller what to type, so the one place
      // a wrong suggestion is guaranteed to be followed. It names why the path
      // cannot be used and asks for a different file; it never echoes back the
      // path it has just refused, and the previous source stays in
      // `source_history` either way.
      throw new PlangonautError(
        `The new source must be an existing file inside the project root, and \`${candidate}\` is not: ` +
        `an absolute path, one climbing out with "..", a symbolic link resolving outside, or a file that is not there ` +
        `all put the record beyond the folder that travels with it, which is the whole reason this command exists.\n` +
        `Copy or write the file into the project first, then name it relative to the root:\n` +
        `  plangonaut re-record --project-root . --kind ${kind} --id ${id} --source-file ${PORTABLE_SOURCE_PLACEHOLDER} --owner <owner> --reason "<why the source changed>" --operation-id <id>\n` +
        `What is recorded now is kept: ${previousPath ? `${label} still stands on ${previousPath}` : `${label} records no source yet`}, and nothing was written.`
      );
    }
    const bytes = fs.readFileSync(confined);
    if (!bytes.length || !bytes.toString("utf8").trim()) throw new PlangonautError(`The new source cannot be empty: ${candidate}`);
    relative = candidate.replaceAll("\\", "/");
    digest = sha256(bytes);
  } else {
    target = (state.gates ?? []).find((item) => item.name === id || item.id === id);
    if (!target) throw new PlangonautError(`Gate not found: ${id}. Nothing was written.`);
    label = `gate ${target.name || target.id}`;
    previousPath = nonEmpty((target as any).evidence) ? String((target as any).evidence) : null;
    previousDigest = /^[a-f0-9]{64}$/.test(String((target as any).evidence_sha256 ?? "")) ? String((target as any).evidence_sha256) : null;
    // Gate evidence obeys the rule `plangonaut gate` enforces, unchanged: an existing,
    // non-empty file inside the project and outside the reserved `.beave`.
    const evidence = verifiedEvidence(root, path.resolve(required(flags, "source-file")));
    relative = evidence.relative;
    digest = evidence.hash;
  }

  if (previousPath !== null && previousDigest !== null && previousPath.replaceAll("\\", "/") === relative && previousDigest === digest) {
    throw new PlangonautError(
      `${label} already records ${relative} at that digest. There is nothing to re-record; no changes written.`
    );
  }

  const timestamp = now();
  const eventId = crypto.randomUUID();
  const supersession: RecordedSourceSupersession = {
    path: previousPath,
    sha256: previousDigest,
    superseded_at: timestamp,
    superseded_by: owner,
    reason,
    event_id: eventId,
  };
  const history: RecordedSourceSupersession[] = [...((target.source_history as RecordedSourceSupersession[]) ?? []), supersession];
  if (kind === "override") Object.assign(target, { source: relative, source_sha256: digest, source_history: history });
  else Object.assign(target, { evidence: relative, evidence_sha256: digest, source_history: history });

  state.updated_at = timestamp;
  const revision = state.revision + 1;
  state.revision = revision;
  state.last_event_id = eventId;
  const event = {
    event_id: eventId,
    type: "RECORDED_SOURCE_UPDATED",
    state_revision: revision,
    at: timestamp,
    idempotency_key: key,
    kind,
    target_id: kind === "override" ? target.id : target.name || target.id,
    previous_source: previousPath,
    previous_source_sha256: previousDigest,
    source: relative,
    source_sha256: digest,
    reason,
    owner,
  };
  const transaction = beginFileTransaction(root, event, []);
  try {
    commitState(root, location, state, event);
    completeFileTransaction(transaction);
  } catch (error) {
    if (fs.existsSync(transaction)) rollbackFileTransaction(root, transaction);
    throw error;
  }
  console.log(
    `Re-recorded the source of ${label}.\n` +
      `  was: ${previousPath ?? "<nothing recorded>"}${previousDigest ? ` @${previousDigest}` : ""}\n` +
      `  now: ${relative} @${digest}\n` +
      `The previous path and digest are kept on the record in source_history and in event ${eventId}. No stored digest was edited: the new one was computed from the file.`
  );
}

// Everything `forecast` writes with. `--project-root` and `--operation-id` are not
// in the list: the first says where, the second says who, and neither is a
// statement about the project. So `plangonaut forecast --project-root .` reads.
const FORECAST_WRITE_OPTIONS = [
  "owner", "phase", "known-work", "conditional-work", "questions", "operations", "cycles",
  "confidence", "confidence-reason", "cycle-state", "change-reason", "expected-revision",
];

/**
 * D5 / FR-024 — record or read the progress forecast.
 *
 * Not behind `assertNotBlocked`, and the reason is in the vocabulary: `BLOCCATO` is
 * one of the four cycle states. A command that refused while the project was
 * blocked could never record the state that says the project is blocked, which is
 * the moment the forecast matters most. Same reasoning as `re-record`: this
 * observes and describes, it does not move the project forward. It cannot pass a
 * gate, change a status, close a module or touch the exact next action.
 */
function forecast(flags: Flags): void {
  const root = resolveProject(required(flags, "project-root"));
  const writing = FORECAST_WRITE_OPTIONS.some((option) => flags[option] !== undefined);

  if (!writing) {
    const state = validateRoot(root);
    const entry = state.progress_forecast;
    if (!entry) {
      console.log(`${FORECAST_NEVER_RECORDED}\nRecord one with: ${FORECAST_RECORD_COMMAND}`);
      return;
    }
    console.log(forecastMarkdown(state, 3).join("\n").trimEnd());
    return;
  }

  const key = idempotencyKey(flags);
  if (checkIdempotency(root, key)) return console.log(`Idempotent retry: forecast already applied.`);
  const { location, state } = loadState(root);
  const owner = required(flags, "owner").trim();
  assertKnownOwner(state, owner);

  /*
   * Who is making this estimate has to be said, not inferred from who ran the
   * command. An agent's forecast and a person's commitment are different
   * claims, and the folder was recording them identically.
   */
  const authoredRaw = nonEmpty(flags.author) ? String(flags.author).trim().toLowerCase() : null;
  if (authoredRaw !== null && authoredRaw !== "agent" && authoredRaw !== "human") {
    throw new PlangonautError(`--author must be agent or human; got ${flags.author}. Nothing was written.`);
  }
  if (authoredRaw === null) {
    throw new PlangonautError(
      `--author is required: say whether these numbers are the agent's estimate or the user's commitment.\n` +
      `  --author agent   a projection you produced. It is a reading, and the next agent should treat it as one.\n` +
      `  --author human   ranges a person gave or accepted. It is an undertaking.\n` +
      `They were being recorded identically, under the owner who happened to run the command, and a reader could not tell them apart. Nothing was written.`
    );
  }
  const authoredBy = authoredRaw as "agent" | "human";

  const previous = state.progress_forecast ?? null;
  const history = state.forecast_history ?? [];

  if (flags["expected-revision"] !== undefined) {
    const expected = Number(required(flags, "expected-revision"));
    if (!previous) {
      throw new PlangonautError(
        `--expected-revision was given, but this project has never recorded a progress forecast, so there is no revision to match. Nothing was written.`
      );
    }
    if (!Number.isInteger(expected) || expected !== previous.state_revision) {
      throw new PlangonautError(`Stale progress forecast: expected revision ${previous.state_revision}. No changes written.`);
    }
  }

  // The cause of a change is the whole point of keeping a history. A forecast that
  // moved and cannot say why is the failure D5 was recorded against.
  const changeReason = typeof flags["change-reason"] === "string" ? flags["change-reason"].trim() : "";
  if (previous && !changeReason) {
    throw new PlangonautError(
      `--change-reason is required: this project already recorded a progress forecast on ${previous.recorded_at} at revision ${previous.state_revision}, and a forecast that changes without its cause cannot explain itself later. Supply --change-reason "<what changed and why>". Nothing was written.`
    );
  }
  if (!previous && changeReason) {
    throw new PlangonautError(
      `--change-reason was given, but this is the first forecast for this project, so there is nothing it changed from. Put the reasoning in --confidence-reason. Nothing was written.`
    );
  }

  const confidence = required(flags, "confidence").trim().toUpperCase();
  if (!CONFIDENCE_LEVELS.includes(confidence)) {
    throw new PlangonautError(`Unsupported --confidence: ${confidence}. Use one of ${CONFIDENCE_LEVELS.join(", ")}. Nothing was written.`);
  }
  const cycleState = required(flags, "cycle-state").trim().toUpperCase().replaceAll(" ", "_");
  if (!CYCLE_STATES.includes(cycleState)) {
    throw new PlangonautError(`Unsupported --cycle-state: ${cycleState}. Use one of ${CYCLE_STATES.join(", ")}. Nothing was written.`);
  }
  const phase = required(flags, "phase").trim();
  const knownWork = required(flags, "known-work").trim();
  const conditionalWork = required(flags, "conditional-work").trim();
  const confidenceReason = required(flags, "confidence-reason").trim();
  for (const [option, value] of [["phase", phase], ["known-work", knownWork], ["conditional-work", conditionalWork], ["confidence-reason", confidenceReason]] as const) {
    if (!value) throw new PlangonautError(`--${option} cannot be empty. Nothing was written.`);
  }
  const questions = parseForecastRange(flags, "questions");
  const operations = parseForecastRange(flags, "operations");
  const cycles = parseForecastRange(flags, "cycles");

  const events = readEvents(root);
  const derived = forecastDerived(state, events);
  const timestamp = now();
  const eventId = crypto.randomUUID();
  const revision = state.revision + 1;

  const entry: ProgressForecast = {
    phase,
    known_work: knownWork,
    conditional_work: conditionalWork,
    questions,
    operations,
    cycles,
    confidence,
    confidence_reason: confidenceReason,
    cycle_state: cycleState,
    change_reason: previous ? changeReason : null,
    recorded_by: owner,
    authored_by: authoredBy,
    recorded_at: timestamp,
    state_revision: revision,
    derived,
    signals: [],
  };
  // Distinct governed operations recorded since the previous forecast, which is
  // what the fourth D5 condition counts. Events with no operation id predate the
  // rule that requires one and are not counted as operations here.
  const operationsSincePrevious = previous
    ? new Set(
        events
          .filter((event) => Number.isInteger(event?.state_revision) && event.state_revision > previous.state_revision)
          .map((event) => event?.operation_id)
          .filter((id) => typeof id === "string")
      ).size
    : 0;
  entry.signals = forecastSignals(entry, previous, history, reopenedRecords(events), operationsSincePrevious);

  if (previous) state.forecast_history = [...history, previous];
  else if (state.forecast_history === undefined) state.forecast_history = [];
  state.progress_forecast = entry;
  state.updated_at = timestamp;
  state.revision = revision;
  state.last_event_id = eventId;

  const event = {
    event_id: eventId,
    type: "PROGRESS_FORECAST_RECORDED",
    state_revision: revision,
    at: timestamp,
    idempotency_key: key,
    owner,
    phase,
    known_work: knownWork,
    conditional_work: conditionalWork,
    questions,
    operations,
    cycles,
    confidence,
    confidence_reason: confidenceReason,
    cycle_state: cycleState,
    change_reason: entry.change_reason,
    derived,
    signals: entry.signals,
    previous_state_revision: previous ? previous.state_revision : null,
  };
  const transaction = beginFileTransaction(root, event, []);
  try {
    commitState(root, location, state, event);
    completeFileTransaction(transaction);
  } catch (error) {
    if (fs.existsSync(transaction)) rollbackFileTransaction(root, transaction);
    throw error;
  }

  console.log(
    [
      `Recorded progress forecast at state revision ${revision}.`,
      `  Phase: ${phase}`,
      `  Known work remaining: ${knownWork}`,
      `  Conditional work: ${conditionalWork}`,
      `  Questions: ${forecastRangeText(questions)} | Operations: ${forecastRangeText(operations)} | Cycles: ${forecastRangeText(cycles)}`,
      `  Confidence: ${confidence} — ${confidenceReason}`,
      `  Cycle state, as recorded by you: ${cycleState}`,
      `  Why it changed: ${entry.change_reason ?? "first forecast recorded for this project"}`,
      `  Counted by the engine from the ledgers: open blockers ${derived.open_blockers}${blockerZeroCaveat(state, derived.open_blockers)}, open overrides ${derived.open_overrides}, gates remaining ${derived.gates_remaining}, unresolved modules ${derived.unresolved_modules.length}, open findings ${derived.open_findings}`,
      entry.signals.length
        ? `  Derived loop signals: ${entry.signals.map((signal) => signal.code).join(", ")}`
        : `  Derived loop signals: none in the recorded data.`,
    ].join("\n")
  );
  for (const signal of entry.signals) console.log(`\n${signal.code}: ${signal.observed}`);
  const disagreement = forecastDisagreement(entry);
  if (disagreement) console.log(`\n${disagreement}`);
  if (!derived.status_history_events && ((state.tasks ?? []).length || (state.risks ?? []).length)) {
    console.log(
      `\nReopening signals are not observable in this project: no ledger event recorded the status of the record it changed, so the engine cannot see whether a task or risk returned to an earlier status. Events written from now on do record it. Absence of that signal here is not evidence of absence.`
    );
  }
}

/**
 * The history, checked as history rather than as a file that happens to parse.
 *
 * Two different failures and one note, kept apart on purpose:
 *
 *  - a broken chain or a diverged state is a refusal: the project is not what it
 *    says it is, and continuing would build on it;
 *  - a history with no replay origin is a *note*. Every project written before
 *    this format is in that position, and it is not damaged. It is told what it
 *    cannot prove and which command gives it a starting point.
 */
function historyErrors(root: string, state: State): { errors: string[]; notes: string[] } {
  const outcome = replayFromEvents(root);
  if (outcome.replayable) {
    if (digestOf(outcome.state) !== digestOf(state)) {
      return { errors: [`the state does not match its own history. ${describeDifferences(state, outcome.state, 8).join("; ").trim()}. Rebuild it with: plangonaut replay --project-root . --repair --operation-id <id>`], notes: [] };
    }
    const notes = outcome.unprovenBefore > 0
      ? [outcome.unprovenBefore === 1
          ? `1 event before the replay baseline is kept and is not covered by the replay proof.`
          : `${outcome.unprovenBefore} events before the replay baseline are kept and are not covered by the replay proof.`]
      : [];
    return { errors: [], notes };
  }
  // A chain that is broken, a duplicated event or a line that is not JSON are
  // damage. A history that simply predates the format is not.
  const missingOrigin = outcome.reason?.startsWith("This project's history has no point") === true;
  const emptyHistory = outcome.reason?.startsWith("This project has no event history") === true;
  if (missingOrigin || emptyHistory) return { errors: [], notes: [outcome.reason!] };
  return { errors: [outcome.reason!], notes: [] };
}

// ---------------------------------------------------------------------------
// Governed documents: the ones Plangonaut writes, and the ones it only finds
//
// Plangonaut cannot stop an agent writing a file. It has a filesystem and a
// shell, and no amount of instruction removes them. The pilot demonstrated the
// consequence rather than the risk: the most important document in the project —
// its architecture — was written straight to `docs/…-v1.md` by hand, carried no
// digest, could be changed by anyone without anything noticing, and `validate`
// answered *"Plangonaut state is valid."* for the whole session. It entered the
// ledger only because a person happened to ask.
//
// The lever is therefore not prevention, it is detection, and the agent's own
// mistake is what makes detection cheap. The skill asks for one visible working
// file per logical document with a `-vN` suffix; the agent followed that
// convention exactly and skipped the command that implements it. So a file named
// `something-v1.md` that no artifact claims is almost never a coincidence: it is
// the shape of this precise mistake. That is the high-precision signal.
//
// Two tiers, because one would either miss things or shout at innocent files:
//
//  - **versioned** — `*-v<N>.md` anywhere in the project. Reported always. A
//    repository that happens to hold one is rare; an agent that made this
//    mistake produces one every time.
//  - **governed directory** — any other Markdown file inside a declared governed
//    directory that did not exist when the project was initialised. Reported
//    only when the project recorded what was already there, so adopting a
//    repository with two hundred existing documents does not light up.
//
// What is never reported: the conventional files every repository has
// (`README`, `CHANGELOG`, `LICENSE`, `CONTRIBUTING`, agent instruction files),
// anything inside a dependency or build directory, anything inside the ledger's
// own directories, the derived interview view, and whatever the project listed
// in `document_governance.exclusions` — the escape hatch for a file deliberately
// kept outside the ledger.
//
// A project initialised by an older engine carries no `document_governance`. It
// gets the versioned tier only: without a record of what was already there, the
// second tier cannot tell an agent's new file from a document that predates
// Plangonaut, and guessing would make the warning worthless on exactly the
// projects that have the most to lose.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Backups written before this release, and what happens to them
// ---------------------------------------------------------------------------

/**
 * `backups/` directories in the project that this engine no longer writes to.
 *
 * They are found, reported and left alone. Moving them silently would be the
 * same class of act as writing them there in the first place: a tool deciding
 * on its own what happens to files in somebody's folder. They also *are*
 * backups — the last copy of a document revision may be in one — so deleting
 * them is out of the question and moving them without being asked is close to it.
 */
function legacyBackupDirectories(root: string): Array<{ relative: string; files: number }> {
  const ledger = stateRoot(root);
  const found: Array<{ relative: string; files: number }> = [];
  const walk = (directory: string, prefix: string, depth: number): void => {
    if (depth > 6) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const absolute = path.join(directory, entry.name);
      if (path.resolve(absolute) === path.resolve(ledger)) continue;
      if (UNSCANNED_DIRECTORIES.has(entry.name.toLowerCase())) continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.name === "backups") {
        const files = fs.readdirSync(absolute).filter((name) => name.endsWith(".bak")).length;
        if (files) found.push({ relative, files });
        continue;
      }
      walk(absolute, relative, depth + 1);
    }
  };
  walk(root, "", 0);
  return found;
}

/**
 * Move the old backups under the ledger, on request and never otherwise.
 *
 * Bytes are preserved — the files are copied and verified by digest before the
 * originals go — and a receipt records where each one came from, so the move is
 * reversible by reading it. `--apply` is what performs it; without the flag this
 * reports what it would do and writes nothing.
 */
function migrateBackups(flags: Flags): void {
  const root = resolveProject(required(flags, "project-root"));
  const legacy = legacyBackupDirectories(root);
  if (!legacy.length) {
    console.log(`No backups directory outside ${STATE_DIR}/. Nothing to migrate.`);
    return;
  }
  const destination = path.join(stateRoot(root), ...DOCUMENT_BACKUPS.split("/"));
  const total = legacy.reduce((sum, entry) => sum + entry.files, 0);
  if (flags.apply !== true) {
    console.log(`${total} backup file${total === 1 ? "" : "s"} in ${legacy.length} director${legacy.length === 1 ? "y" : "ies"} would move under ${STATE_DIR}/${DOCUMENT_BACKUPS}/:`);
    for (const entry of legacy) console.log(`  ${entry.relative}/  (${entry.files})`);
    console.log(``);
    console.log(`Nothing was written. To perform it: plangonaut migrate-backups --project-root . --apply`);
    console.log(`The files are copied and verified by digest before the originals are removed, and a receipt records where each one came from.`);
    return;
  }
  fs.mkdirSync(destination, { recursive: true });
  const moved: Array<{ from: string; to: string; sha256: string }> = [];
  for (const entry of legacy) {
    const directory = path.join(root, entry.relative);
    for (const name of fs.readdirSync(directory).filter((item) => item.endsWith(".bak"))) {
      const source = path.join(directory, name);
      const bytes = fs.readFileSync(source);
      const digest = sha256(bytes);
      const prefix = entry.relative === "backups" ? "" : `${entry.relative.replace(/\/backups$/, "").replaceAll("/", "__")}__`;
      let target = path.join(destination, `${prefix}${name}`);
      // A name already taken is kept, not replaced: two identical names from two
      // directories are two different files.
      let attempt = 1;
      while (fs.existsSync(target)) target = path.join(destination, `${prefix}${name}.${attempt++}`);
      fs.copyFileSync(source, target);
      if (sha256(fs.readFileSync(target)) !== digest) {
        throw new PlangonautError(`Copy of ${entry.relative}/${name} does not match its source. The original has been left where it is.`);
      }
      fs.rmSync(source);
      moved.push({ from: `${entry.relative}/${name}`, to: canonicalRelative(path.relative(root, target)), sha256: digest });
    }
    if (!fs.readdirSync(directory).length) fs.rmdirSync(directory);
  }
  const receipt = path.join(destination, `migration-${new Date().toISOString().replaceAll(":", "").replaceAll(".", "")}.json`);
  fs.writeFileSync(receipt, `${JSON.stringify({ moved_at: now(), engine: VERSION, moved }, null, 2)}\n`, "utf8");
  console.log(`Moved ${moved.length} backup file${moved.length === 1 ? "" : "s"} under ${STATE_DIR}/${DOCUMENT_BACKUPS}/.`);
  console.log(`Every copy was verified by digest before its original was removed.`);
  console.log(`Receipt: ${canonicalRelative(path.relative(root, receipt))} — it records where each file came from, so the move can be undone by reading it.`);
}

// ---------------------------------------------------------------------------
// Handoff: integrity is not sufficiency
// ---------------------------------------------------------------------------

/**
 * References in a governed document that point outside the folder it travels in.
 *
 * `project-export` / `project-verify` prove a package arrived **intact**: every
 * file in the manifest, every digest matching. They have never had anything to
 * say about whether it is **sufficient**. A governed document whose entire
 * technical foundation is seven modules under `C:\\...\\release-tools\\` passes
 * `project-verify` without a remark, because that path is not a file of the
 * package and therefore is not in the manifest. Integrity is proved; completeness
 * is not looked at.
 *
 * The pilot is the case. Its brief built the whole strategy on a table of modules
 * living under an absolute path on one machine — one of them named wrongly — and
 * the architecture document leaned on the same files again. A recipient opening
 * that folder gets a table of reusable modules it cannot open, on a machine where
 * that path almost certainly does not exist.
 *
 * **Not every outside reference is a defect**, and treating them alike would make
 * the check useless: a document may legitimately cite where something came from,
 * show an example, or link to something informative. What must not happen is that
 * a *dependency the work needs* is left as a path nobody else can resolve. The
 * engine cannot read intent, so the document declares it, with a marker on the
 * same line:
 *
 *   (external dependency)   needed, deliberately not delivered — reported, allowed
 *   (historical reference)  where this came from — allowed
 *   (example)               illustrative — allowed
 *   (informative)           background — allowed
 *
 * An unqualified path is treated as a dependency, because that is the reading
 * that costs something if it is wrong in the other direction.
 */
const OUTSIDE_PATH = /(?:[A-Za-z]:[\\/][^\s`"'<>|]+|\\\\[^\s`"'<>|]+|(?:\.\.[\\/])+[^\s`"'<>|]+)/g;
const REFERENCE_QUALIFIERS = /\((?:external dependency|historical reference|example|informative)\)/i;
/**
 * A URL is not a filesystem path, and must not be read as one.
 *
 * `https://example.com/a/b` contains two things this checker would otherwise
 * claim: `s:` followed by `//` looks like a drive-qualified path to the Windows
 * branch, and `/example.com/a/b` looks like a POSIX absolute path. Running
 * against the real pilot produced exactly that — `s://external.example/...` reported
 * as a path the recipient cannot open, which is both wrong and the kind of wrong
 * that makes a reader stop trusting the rest of the list.
 *
 * URLs are removed before anything is matched. A document that depends on
 * something reachable over the network has a different problem from one that
 * depends on a file only this machine has, and this check is about the second.
 */
const URL_IN_TEXT = /[a-z][a-z0-9+.-]*:\/\/[^\s`"'<>|)\]]+/gi;

const TRANSIENT_LOCATION = /(?:[\\/]tmp[\\/]|%TEMP%|AppData[\\/]Local[\\/]Temp|scratchpad|[\\/]var[\\/]folders[\\/])/i;

interface OutsideReference {
  document: string;
  line: number;
  text: string;
  qualified: boolean;
  transient: boolean;
}

/**
 * A POSIX absolute path, and the reason it is not looked for everywhere.
 *
 * `C:\...`, a UNC share and a `..` climb are unmistakable: nothing in ordinary
 * English prose looks like one, so they can be recognised wherever they appear.
 * `/opt/project/lib` is different. English is full of things that a permissive
 * pattern reads as a path — a route in a sentence, a fraction, an option written
 * `--flag/--other`, a date — and a check that flags those is a check somebody
 * turns off, which costs more than the paths it would have caught.
 *
 * So a POSIX absolute path is recognised only in **structured positions**, where
 * something has already declared that what follows is a location:
 *
 *   - a Markdown link or image target, `[…](/opt/project/lib)`
 *   - a Markdown reference definition, `[id]: /opt/project/lib`
 *   - a line that qualifies its reference — `(external dependency)` and the rest
 *     — because the qualifier is itself the declaration that this is a location
 *   - a field of the ledger that holds a path
 *
 * Two segments minimum, so `/` and `/usr` alone are not paths. Trailing
 * punctuation is trimmed, because a path at the end of a sentence keeps the full
 * stop otherwise.
 */
const POSIX_ABSOLUTE = /\/(?:[A-Za-z0-9._@+-]+)(?:\/[A-Za-z0-9._@+-]+)+\/?/g;

/** A Markdown construct whose payload is a location and not prose. */
const MARKDOWN_TARGET = /!?\[[^\]\n]*\]\(\s*<?([^)\s>]+)>?[^)]*\)/g;
const MARKDOWN_REFERENCE = /^\s{0,3}\[[^\]\n]+\]:\s*<?([^\s>]+)>?/;

/** Trailing sentence punctuation is not part of a path. */
const trimTail = (value: string) => value.replace(/[.,;:!?)\]}"'`]+$/, "");

function posixInStructuredPositions(line: string): string[] {
  const found: string[] = [];
  const take = (candidate: string) => {
    const cleaned = trimTail(candidate.trim());
    if (POSIX_ABSOLUTE.test(cleaned) && cleaned.startsWith("/")) found.push(cleaned);
    POSIX_ABSOLUTE.lastIndex = 0;
  };

  for (const match of line.matchAll(MARKDOWN_TARGET)) take(match[1]);
  const reference = MARKDOWN_REFERENCE.exec(line);
  if (reference) take(reference[1]);
  // A qualified line has already said that it is naming something outside; the
  // qualifier is the structure. It is reported as a declaration, not blocked.
  if (REFERENCE_QUALIFIERS.test(line)) {
    for (const match of line.match(POSIX_ABSOLUTE) ?? []) take(match);
  }
  return [...new Set(found)];
}

/**
 * Paths the ledger itself records, which are structured by definition.
 *
 * Every one of these is written through `recordedSourceFile` by this engine and
 * cannot be absolute any more. A project written by an earlier engine can hold
 * one, and that is precisely the case worth reporting: it is a record nobody can
 * resolve, and it is in the ledger rather than in prose, so there is no prose to
 * be careful about.
 */
function ledgerPathFields(state: State): Array<{ where: string; value: string }> {
  const found: Array<{ where: string; value: string }> = [];
  const add = (where: string, value: unknown) => {
    if (nonEmpty(value)) found.push({ where, value: String(value) });
  };
  for (const item of state.human_overrides ?? []) {
    add(`override ${item.id}.source`, (item as any).source);
    add(`override ${item.id}.reconciliation_evidence`, (item as any).reconciliation_evidence);
    for (const previous of (item as any).source_history ?? []) {
      add(`override ${item.id}.source_history`, previous?.path);
    }
  }
  for (const item of state.gates ?? []) add(`gate ${item.name || item.id}.evidence`, (item as any).evidence);
  for (const item of state.modules ?? []) add(`module ${item.id}.evidence`, item.evidence);
  for (const item of state.evidence ?? []) {
    add(`evidence ${(item as any)?.id ?? "?"}.path`, typeof item === "string" ? item : (item as any)?.path);
  }
  for (const item of state.artifacts ?? []) {
    add(`artifact ${item.id}.base_path`, item.base_path);
    add(`artifact ${item.id}.working_path`, item.working_path);
  }
  for (const item of state.interview_log ?? []) {
    add(`${(item as any).id}.reconstructed_from`, (item as any).reconstructed_from);
    for (const document of (item as any).documents ?? []) add(`${(item as any).id}.documents`, document);
  }
  return found;
}

/**
 * Outside references in Markdown the ledger does **not** govern.
 *
 * `handoff-check` read only governed documents, which meant it could report a
 * folder as self-sufficient while a file sitting beside them pointed at half a
 * machine. Silence about a file nobody governs reads as "checked and clean", and
 * it was neither.
 *
 * These are reported separately and never as blocking, because the limit is real
 * and worth stating rather than papering over: the file has no digest, so it can
 * change after this check without anything noticing, and its qualifiers cannot
 * be trusted the way a governed document's can. What the reader gets is the
 * fact — this was looked at, here is what it says, and here is why the answer is
 * weaker than for the documents above.
 *
 * The scan is the same deterministic one used everywhere: `markdownFiles`
 * skips dependency and build directories, dot-directories, the ledger's own
 * directories and the conventional repository files, so a README or a
 * changelog never appears here.
 */
function ungovernedReferences(root: string, state: State): OutsideReference[] {
  const governed = new Set<string>();
  for (const artifact of state.artifacts ?? []) {
    for (const value of [artifact.working_path, artifact.base_path]) {
      if (nonEmpty(value)) governed.add(canonicalRelative(String(value)));
    }
  }
  const view = (state as any).interview_view?.path;
  if (nonEmpty(view)) governed.add(canonicalRelative(String(view)));

  const governance = documentGovernance(state);
  const found: OutsideReference[] = [];
  for (const relative of markdownFiles(root)) {
    if (governed.has(relative)) continue;
    if (excludedFromGovernance(relative, governance.exclusions)) continue;
    const basename = path.basename(relative).replace(/\.md$/i, "").toLowerCase();
    if (UNGOVERNED_BASENAMES.has(basename)) continue;
    const absolute = existingFileInside(root, relative);
    if (!absolute) continue;
    fs.readFileSync(absolute, "utf8").split(/\r?\n/).forEach((raw, index) => {
      const qualified = REFERENCE_QUALIFIERS.test(raw);
      const line = raw.replace(URL_IN_TEXT, (match) => " ".repeat(match.length));
      const candidates = [...(line.match(OUTSIDE_PATH) ?? []), ...posixInStructuredPositions(line)];
      for (const match of [...new Set(candidates)]) {
        found.push({ document: relative, line: index + 1, text: match, qualified, transient: TRANSIENT_LOCATION.test(match) });
      }
    });
  }
  return found;
}

function outsideReferences(root: string, state: State): OutsideReference[] {
  const found: OutsideReference[] = [];

  // 1. The ledger's own path fields. Structured, so every spelling counts.
  for (const { where, value } of ledgerPathFields(state)) {
    const cleaned = value.replace(URL_IN_TEXT, "");
    const unportable =
      OUTSIDE_PATH.test(cleaned) || (cleaned.startsWith("/") && POSIX_ABSOLUTE.test(cleaned));
    OUTSIDE_PATH.lastIndex = 0;
    POSIX_ABSOLUTE.lastIndex = 0;
    if (!unportable) continue;
    found.push({
      document: `${STATE_DIR}/state.json`,
      line: 0,
      text: `${where} = ${value}`,
      qualified: false,
      transient: TRANSIENT_LOCATION.test(value),
    });
  }

  // 2. The governed documents.
  const documents = new Set<string>();
  for (const artifact of state.artifacts ?? []) {
    for (const value of [artifact.working_path, artifact.base_path]) {
      if (nonEmpty(value)) documents.add(canonicalRelative(String(value)));
    }
  }
  for (const relative of [...documents].sort()) {
    const absolute = existingFileInside(root, relative);
    if (!absolute) continue;
    const lines = fs.readFileSync(absolute, "utf8").split(/\r?\n/);
    lines.forEach((raw, index) => {
      const qualified = REFERENCE_QUALIFIERS.test(raw);
      // Blank out any URL, keeping the line's length so nothing else shifts.
      const line = raw.replace(URL_IN_TEXT, (match) => " ".repeat(match.length));
      const candidates = [...(line.match(OUTSIDE_PATH) ?? []), ...posixInStructuredPositions(line)];
      for (const match of [...new Set(candidates)]) {
        found.push({
          document: relative,
          line: index + 1,
          text: match,
          qualified,
          transient: TRANSIENT_LOCATION.test(match),
        });
      }
    });
  }
  return found;
}

/**
 * Is this folder enough for somebody who was not in the conversation?
 *
 * Deliberately a separate command from `validate`. They answer two different
 * questions and conflating them would weaken both: `validate` asks whether the
 * record is sound, and a project mid-interview is entitled to be sound and
 * nowhere near deliverable. This asks whether the folder could be handed over
 * today, which is only ever a question at the end.
 *
 * Blocking and advisory are kept apart for the same reason. An unresolvable
 * dependency is blocking: the recipient cannot do the work. An empty requirements
 * ledger on a project still interviewing is a fact, not a fault.
 */
function handoffCheck(flags: Flags): void {
  const root = resolveProject(required(flags, "project-root"));
  const { state } = loadState(root);
  const blocking: string[] = [];
  const advisory: string[] = [];

  // 1. The record itself has to hold before anything else is worth saying.
  //
  // Including the history: a folder whose events do not reproduce its state is
  // not handed over, and the full diagnosis is printed rather than a sentence,
  // because the person reading it is the one who has to act on it.
  const diagnosis = integrityDiagnosis(root);
  if (!diagnosis.sound && diagnosis.defect) {
    blocking.push(
      `mechanical integrity has failed: ${diagnosis.defect.category}` +
      `${diagnosis.defect.line > 0 ? ` at event line ${diagnosis.defect.line}` : ""}. ` +
      `plangonaut replay --verify --project-root . prints the whole diagnosis. No decision can waive this.`
    );
  }
  blocking.push(...stateErrors(root, state));
  blocking.push(...documentIntegrityErrors(root, state));
  blocking.push(...recordedDigestErrors(root, state));

  // 2. References out of the folder.
  for (const reference of outsideReferences(root, state)) {
    // A ledger field has no line number, and printing `:0` would invent one.
    const where = reference.line ? `${reference.document}:${reference.line}` : reference.document;
    if (reference.transient && !reference.qualified) {
      blocking.push(`${where} points at a temporary location: ${reference.text}. It will not exist on the recipient's machine, and may not exist here tomorrow.`);
    } else if (!reference.qualified) {
      blocking.push(
        `${where} points outside the project: ${reference.text}. The recipient cannot open it. ` +
        `Bring it into the folder, summarise it in place with its reasoning, or mark the line "(external dependency)" to declare it needed and deliberately not delivered.`
      );
    } else {
      advisory.push(`${where} refers to ${reference.text}, qualified on the line. It travels as a declaration, not as content.`);
    }
  }

  // 3. Modules: nothing may be simply unexamined.
  const progress = moduleProgress(state);
  if (progress.untouched.length) {
    blocking.push(
      `module${progress.untouched.length === 1 ? "" : "s"} ${progress.untouched.join(", ")} ${progress.untouched.length === 1 ? "is" : "are"} NOT STARTED. ` +
      `A module nobody examined is not the same as one that does not apply: confirm it, or record it NOT APPLICABLE with the reason.`
    );
  }
  if (progress.inProgress.length) {
    advisory.push(`module${progress.inProgress.length === 1 ? "" : "s"} ${progress.inProgress.join(", ")} ${progress.inProgress.length === 1 ? "is" : "are"} in progress and not confirmed.`);
  }

  // 4. The minimum a recipient needs in order to act.
  if (!state.requirements.length) blocking.push(`no requirements are recorded, so nothing states what the result has to do.`);
  if (!state.decisions.length) blocking.push(`no decisions are recorded, so nothing states what was chosen or why.`);
  if (!state.tasks.length) blocking.push(`no tasks are recorded, so nothing states what to do first.`);

  /*
   * 4b. Is the work executable, and is anybody accountable for it?
   *
   * The check this command was missing. A folder holding eighty-two decisions
   * and three administrative tasks satisfied every line above it — there *are*
   * requirements, there *are* decisions, there *are* tasks — and could not be
   * executed by anybody, because nothing in it said what to build, who builds
   * it, or how they would know they had.
   *
   * It is skipped entirely when the project has declared that it is not to be
   * built. A feasibility study with no integration plan is not defective.
   */
  const readiness = readinessReport(state, root);
  if (readiness.intent === "YES") {
    for (const finding of readiness.execution.findings) blocking.push(finding);
  } else if (readiness.intent === "UNDECLARED") {
    blocking.push(
      `nobody has declared whether this project is meant to be built, so this check cannot say whether an execution plan is missing or deliberately absent. ` +
      `Record it: plangonaut execution-intent --project-root . --execution|--definition-only --reason "<why>" --owner <owner> --operation-id <id>.`
    );
  } else {
    advisory.push(
      `this project is recorded DEFINITION_ONLY (${state.execution_intent?.reason ?? "no reason recorded"}), so execution readiness was not assessed. ` +
      `This folder is not an execution package, and is not expected to be one.`
    );
  }

  // 4c. Two documents saying the same thing, one of them governed.
  for (const finding of duplicateDocumentFindings(root, state)) blocking.push(finding);

  // 4d. Reads a plan rests on that no longer describe the file.
  for (const entry of readStandings(root, state)) {
    if (entry.standing === "PROVED") continue;
    const dependents = (entry.record.used_by ?? []).join(", ");
    if (entry.standing === "CHANGED SINCE") {
      blocking.push(
        `${entry.record.path} was read for ${entry.record.purpose} and has changed since${dependents ? `; ${dependents} rest${dependents.includes(",") ? "" : "s"} on that reading` : ""}. ` +
        `The conclusions drawn from it may no longer hold. Re-read and record it, or record a decision that the change does not affect them.`
      );
    } else {
      blocking.push(`${entry.record.path} was recorded as read and is no longer in the folder${dependents ? `; ${dependents} rest on it` : ""}.`);
    }
  }
  const assurance = blockerAssurance(state);
  if (assurance.blockers_assurance === "UNKNOWN") {
    advisory.push(`no blocker was ever recorded and nobody recorded finding none: plangonaut blocker-verify-none is how that absence is stated.`);
  }
  if (!state.risks.length) advisory.push(`no risks are recorded.`);

  // 5. An interaction left open is an instruction the recipient cannot finish.
  const open = openInterviewEntries(state);
  if (open.unapplied.length) blocking.push(`${open.unapplied[0].id} has an answer that was never applied; what it changed is not in the record.`);
  if (state.needs_reconciliation) blocking.push(`an override is open and unreconciled; the project's current direction is not settled.`);

  // 6. A document superseded with nowhere to go next.
  for (const artifact of state.artifacts ?? []) {
    if (String(artifact.status).toUpperCase() !== "SUPERSEDED") continue;
    if (!(artifact.provenance ?? []).length) {
      blocking.push(`artifact ${artifact.id} is SUPERSEDED and names nothing that replaced it, so a reader finds a document declared out of date and no way to the current one.`);
    }
  }

  // 7. Documents outside the ledger, and what this check could not see in them.
  const unclaimed = unclaimedDocumentReport(root, state);
  for (const finding of unclaimed.findings) {
    blocking.push(
      `${finding} A folder cannot be called self-sufficient while a document in it is outside the record: it has no digest, ` +
      `so nothing notices it changing, and this check cannot vouch for what it says. ` +
      `Close it by recording it (doc-diff then doc-save), or declare it deliberately ungoverned with ` +
      `plangonaut govern --exclude <path> --reason "<why>" --owner <owner> --operation-id <id>, ` +
      `which is an owner's decision and is recorded as one. Verify with plangonaut validate --strict.`
    );
  }

  // 8. What the ungoverned files say, and the limit on believing it.
  const ungoverned = ungovernedReferences(root, state);
  if (ungoverned.length) {
    advisory.push(
      `${ungoverned.length} reference${ungoverned.length === 1 ? "" : "s"} outside the project ${ungoverned.length === 1 ? "is" : "are"} in Markdown the ledger does not govern. ` +
      `They are not blocking and they are not cleared: an ungoverned file has no digest, so it can change after this check without anything noticing, ` +
      `and a qualifier written in one cannot be relied on the way a governed document's can.`
    );
    for (const reference of ungoverned) {
      advisory.push(
        `  ${reference.document}:${reference.line} — ${reference.text}` +
        `${reference.transient ? " (a temporary location)" : ""}${reference.qualified ? " (qualified on the line, but the file is not governed)" : ""}`
      );
    }
  }

  // 9. Where the prose and the typed ledger disagree.
  for (const finding of ledgerCoherenceFindings(root, state)) {
    blocking.push(
      `${finding} A recipient reads the documents and then goes looking in the ledger; these two do not agree, ` +
      `so one of them is wrong and this check cannot say which. Close it by recording what the document claims, or by rewriting the claim.`
    );
  }

  advisory.push(...imbalanceLines(progress));

  if (flags.json === true) {
    console.log(JSON.stringify({
      deliverable: blocking.length === 0,
      definition: readiness.definition.verdict,
      execution_readiness: readiness.execution.verdict,
      handoff_readiness: blocking.length ? "FAILED" : "PASSED",
      execution_intent: readiness.intent === "UNDECLARED" ? "NOT DECLARED" : readiness.intent === "NO" ? "DEFINITION_ONLY" : "EXECUTION",
      blocking,
      advisory,
    }, null, 2));
    if (blocking.length) reportedExitCode = 2;
    return;
  }
  console.log(readinessLines(readiness, blocking.length ? "FAILED" : "PASSED").join("\n"));
  console.log("");
  if (blocking.length) {
    console.log(`This folder is not ready to hand off. ${blocking.length} thing${blocking.length === 1 ? "" : "s"} would stop somebody who was not in the conversation:`);
    for (const line of blocking) console.log(`- ${line}`);
  } else {
    console.log(`This folder can be handed off: nothing it depends on is unreachable, and the record is complete enough to act on.`);
  }
  if (advisory.length) {
    console.log(`\nWorth knowing, not blocking:`);
    for (const line of advisory) console.log(`- ${line}`);
  }
  console.log(`\nIntegrity and sufficiency are different questions. plangonaut validate and project-verify answer the first; this answers the second.`);
  if (blocking.length) {
    console.log(
      `\nEvery blocking finding above says what was found and how to close it. Three closures exist, and they are not interchangeable:\n` +
      `  record it      bring the thing into the ledger, so the folder carries it.\n` +
      `  qualify it     when the reference is deliberate, mark its line "(external dependency)", "(historical reference)",\n` +
      `                 "(example)" or "(informative)". The first says needed and not delivered; the others say not needed.\n` +
      `  accept it      a decision, not a workaround. It belongs to the owner the concern falls under -- technical for a\n` +
      `                 dependency, product for scope, safety for a risk -- and it is recorded as a decision with its\n` +
      `                 provenance, not as a silenced warning. This command has no flag for accepting a finding, on purpose.\n` +
      `Re-run plangonaut handoff-check --project-root . to verify a finding is closed.`
    );
  }
  if (blocking.length) throw new PlangonautError(`Handoff check failed: ${blocking.length} blocking finding${blocking.length === 1 ? "" : "s"}.`, "PROJECT_STATE_UNTRUSTED");
}

/**
 * Declare a file governed or deliberately not.
 *
 * `document_governance` lives in `state.json`, which is replayed and digested,
 * so it cannot be hand-edited: changing it in a text editor puts the state out
 * of step with its own history and `validate` refuses the project — punishing
 * somebody for doing the thing the warning asked them to do. That is not a
 * reason to move the list somewhere unverified. It is a reason to give it a
 * command, which is what every other deliberate decision in this product has.
 *
 * `--exclude` records that a file is intentionally outside the ledger, with the
 * reason, in an event. `--include` withdraws the exclusion. Neither writes or
 * moves the file itself.
 */
function govern(flags: Flags): void {
  const root = resolveProject(required(flags, "project-root"));
  const key = idempotencyKey(flags);
  if (checkIdempotency(root, key)) return console.log(`Idempotent retry: governance already recorded.`);
  const { location, state } = loadState(root);
  const owner = required(flags, "owner").trim();
  assertKnownOwner(state, owner);

  const excluding = nonEmpty(flags.exclude);
  const including = nonEmpty(flags.include);
  if (excluding === including) {
    throw new PlangonautError(`Pass exactly one of --exclude <path> or --include <path>. Nothing was written.`);
  }
  const target = canonicalRelative(String(excluding ? flags.exclude : flags.include));
  const refusal = artifactPathRefusal("A governed path", target);
  if (refusal) throw new PlangonautError(`${refusal}\nNothing was written.`);

  const current = (state as any).document_governance ?? {
    directories: [...DEFAULT_GOVERNED_DIRECTORIES],
    exclusions: [],
    // An older project never recorded what was already in the folder, and this
    // command must not invent it: `null` keeps meaning "unknown", which is what
    // `unclaimedDocuments` reads it as.
    preexisting: null,
  };
  const exclusions: string[] = [...(current.exclusions ?? [])];
  const at = now();

  if (excluding) {
    const reason = required(flags, "reason").trim();
    if (!reason) throw new PlangonautError(`--reason cannot be empty: an exclusion nobody explained is indistinguishable from a file that was forgotten. Nothing was written.`);
    if (exclusions.includes(target)) throw new PlangonautError(`${target} is already excluded. Nothing was written.`);
    exclusions.push(target);
    exclusions.sort();
  } else {
    const index = exclusions.indexOf(target);
    if (index < 0) throw new PlangonautError(`${target} is not excluded. Nothing was written.`);
    exclusions.splice(index, 1);
  }

  (state as any).document_governance = { ...current, exclusions };
  state.updated_at = at;
  const revision = state.revision + 1;
  const eventId = crypto.randomUUID();
  state.revision = revision;
  state.last_event_id = eventId;
  const event = {
    event_id: eventId,
    type: excluding ? "DOCUMENT_GOVERNANCE_EXCLUDED" : "DOCUMENT_GOVERNANCE_INCLUDED",
    state_revision: revision, at, idempotency_key: key, path: target, owner,
    reason: excluding ? String(flags.reason).trim() : null,
  };
  commitState(root, location, state, event);
  console.log(
    excluding
      ? `${target} is recorded as deliberately outside the ledger. validate will not report it again; the reason is in event ${eventId}.`
      : `${target} is governed again, and validate will report it if no artifact claims it.`
  );
}

// ---------------------------------------------------------------------------
// Which engine is running, and which one this project was written by
// ---------------------------------------------------------------------------

/**
 * The versions in play, kept apart because they are four different facts.
 *
 * A real pilot was attributed to the wrong release for want of this. The engine
 * on the PATH was `0.3.0-alpha.3`, the project's state recorded `0.3.0-alpha.3`,
 * and the review of that session was filed under `alpha4` — because `status`
 * printed neither number, `beave_version` was read as "the project's version"
 * when it means "what created it", and nothing said which engine was doing the
 * work. Every one of those is individually forgivable; together they made it
 * impossible to answer *which Plangonaut was this* without reading the state file
 * by hand.
 *
 *   running    the CLI executing right now
 *   created    what wrote the project's first state, or last migrated it
 *   last_wrote what most recently committed to it, which is not the same thing
 *   schema     the shape of the state, which is what compatibility turns on
 *
 * `last_wrote` is absent on a project written before this release, and says so
 * rather than guessing: a missing field means the information was never
 * recorded, which is different from the engine never having changed.
 *
 * **Nothing here reaches the network.** The running version comes from this
 * package's own `VERSION`, and the rest from the project on disk. There is no
 * registry lookup, no "is a newer one available", and there will not be: that
 * question has nothing to do with whether this project can be opened.
 */
interface VersionProvenance {
  running: string;
  created: string | null;
  last_wrote: string | null;
  schema: number | null;
  schema_expected: number;
  compatibility: "SAME" | "CLI_NEWER" | "PROJECT_NEWER" | "UNKNOWN";
  migration_required: boolean;
  note: string;
}

/**
 * Compare two version strings far enough to order two releases of this product.
 *
 * Deliberately not a full SemVer implementation: it compares the numeric parts
 * and then the prerelease text, which orders `0.3.0-alpha.3` before
 * `0.3.0-alpha.4` and `0.3.0-alpha.9` before `0.3.0-alpha.10`. Anything it
 * cannot order returns `null`, and the caller reports `UNKNOWN` rather than
 * inventing a direction — a wrong answer here would tell somebody to migrate a
 * project that does not need it.
 */
function compareVersions(left: string, right: string): number | null {
  const parse = (value: string) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(value.trim());
    if (!match) return null;
    return {
      numbers: [Number(match[1]), Number(match[2]), Number(match[3])],
      pre: match[4] ?? null,
    };
  };
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index += 1) {
    if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] < b.numbers[index] ? -1 : 1;
  }
  // A release is always later than its own prereleases.
  if (a.pre === null && b.pre === null) return 0;
  if (a.pre === null) return 1;
  if (b.pre === null) return -1;
  if (a.pre === b.pre) return 0;
  const segments = (value: string) => value.split(".").map((part) => (/^\d+$/.test(part) ? Number(part) : part));
  const left_ = segments(a.pre);
  const right_ = segments(b.pre);
  for (let index = 0; index < Math.max(left_.length, right_.length); index += 1) {
    const one = left_[index];
    const two = right_[index];
    if (one === undefined) return -1;
    if (two === undefined) return 1;
    if (one === two) continue;
    if (typeof one === "number" && typeof two === "number") return one < two ? -1 : 1;
    if (typeof one === "number") return -1;
    if (typeof two === "number") return 1;
    return String(one) < String(two) ? -1 : 1;
  }
  return 0;
}

function versionProvenance(state: State): VersionProvenance {
  const created = nonEmpty((state as any).beave_version) ? String((state as any).beave_version) : null;
  const lastWrote = nonEmpty((state as any).last_engine_version)
    ? String((state as any).last_engine_version)
    : null;
  const schema = typeof state.schema_version === "number" ? state.schema_version : null;

  // The project's own claim is the most recent engine that touched it, and the
  // creating engine only when nothing else was recorded.
  const projectVersion = lastWrote ?? created;
  const order = projectVersion ? compareVersions(VERSION, projectVersion) : null;
  const compatibility: VersionProvenance["compatibility"] =
    projectVersion === null || order === null
      ? "UNKNOWN"
      : order === 0
        ? "SAME"
        : order > 0
          ? "CLI_NEWER"
          : "PROJECT_NEWER";

  const migrationRequired = schema !== null && schema !== SCHEMA_VERSION;

  let note: string;
  if (migrationRequired) {
    note =
      `This project's state is schema ${schema} and this engine writes schema ${SCHEMA_VERSION}. ` +
      `Run plangonaut migrate --project-root . before working on it.`;
  } else if (compatibility === "SAME") {
    note = `The running CLI and the engine that last wrote this project are the same version.`;
  } else if (compatibility === "CLI_NEWER") {
    note =
      `This project was last written by ${projectVersion} and you are running ${VERSION}. ` +
      `The schema is the same, so nothing needs migrating and nothing has been changed. ` +
      `What it means is that any observation about this project belongs to ${projectVersion} ` +
      `unless you work on it further — attributing it to ${VERSION} would be attributing it to an engine that never ran here.`;
  } else if (compatibility === "PROJECT_NEWER") {
    note =
      `This project was last written by ${projectVersion} and you are running ${VERSION}, which is older. ` +
      `The schema is the same, so it can be read — but a newer engine may have recorded things this one does not know about, ` +
      `and nothing here will tell you which. Use the newer CLI if you have it.`;
  } else {
    note =
      projectVersion === null
        ? `This project records no engine version. It was written before that was kept, so which engine produced it cannot be established from the folder.`
        : `This project records ${projectVersion}, which cannot be ordered against ${VERSION}. No comparison is claimed.`;
  }

  return {
    running: VERSION,
    created,
    last_wrote: lastWrote,
    schema,
    schema_expected: SCHEMA_VERSION,
    compatibility,
    migration_required: migrationRequired,
    note,
  };
}

/** The same thing as lines, for `resume` and the context pack. */
function provenanceLines(state: State): string[] {
  const provenance = versionProvenance(state);
  const lines = [
    `- CLI running now: ${provenance.running}`,
    `- Project created by: ${provenance.created ?? "not recorded"}`,
    `- Project last written by: ${provenance.last_wrote ?? "not recorded (predates this field)"}`,
    `- State schema: ${provenance.schema ?? "not recorded"} (this engine writes ${provenance.schema_expected})`,
  ];
  if (provenance.compatibility !== "SAME" || provenance.migration_required) {
    lines.push(`- ${provenance.migration_required ? "MIGRATION REQUIRED" : "VERSION MISMATCH"}: ${provenance.note}`);
  }
  return lines;
}

/** Where a Genesis project is expected to put the documents Plangonaut writes. */
const DEFAULT_GOVERNED_DIRECTORIES = ["docs"];

/** Documentation that belongs to the repository rather than to the plan. */
const UNGOVERNED_BASENAMES = new Set([
  "readme", "changelog", "changes", "history", "license", "licence", "notice",
  "contributing", "code_of_conduct", "code-of-conduct", "security", "support",
  "authors", "maintainers", "governance", "roadmap", "install", "upgrading",
  "agents", "claude", "gemini", "copilot-instructions", "cursorrules",
]);

/** Directories whose Markdown is somebody else's: dependencies, builds, caches. */
const UNSCANNED_DIRECTORIES = new Set([
  "node_modules", "vendor", "bower_components", "dist", "build", "out", "target",
  "coverage", "tmp", "temp", "__pycache__", ".venv", "venv", "site-packages",
  // Dependencies and vendored trees under their other common names.
  "third_party", "third-party", "thirdparty", "deps", "pods", "packages",
  "elm-stuff", "bundle", "jspm_packages",
  // Build and cache output under their other common names. Anything beginning
  // with a dot is already skipped, which covers .git, .cache, .next, .gradle,
  // .tox and the rest.
  "obj", "bin", "_build", "cmake-build-debug", "cmake-build-release", "htmlcov",
  "__snapshots__", "generated", "autogen",
]);

/*
 * Where a project document lives.
 *
 * `handoff-check` and `validate` are asking one question -- "is there a document
 * here that the plan rests on and nothing is governing?" -- and the answer is
 * about project documents: specifications, plans, requirements, decisions,
 * registers, notes somebody declared relevant. It is not about the repository's
 * own working files, and a check that reports those is a check somebody turns
 * off, which costs more than the documents it would have caught.
 *
 * Three things bound it, and all three were already partly true. Written down
 * here so the scope is one thing a reader can see rather than three:
 *
 *   the extension   only Markdown. An ordinary source file, a lockfile, a binary
 *                   asset or a build artifact is never a candidate, whatever it
 *                   is named and wherever it sits.
 *   the directory   dependency, build and cache trees are skipped outright, as
 *                   is anything beginning with a dot, and so is a recorded
 *                   exclusion.
 *   the place       a document is looked for at the project root, in the
 *                   governed directories, and in directories whose name says
 *                   what they hold. A -vN.md file three levels down inside
 *                   application code is somebody's working note; reporting it as
 *                   an ungoverned deliverable is a guess dressed as a finding.
 */
const DOCUMENT_DIRECTORIES = new Set([
  "doc", "docs", "documentation", "spec", "specs", "specification", "specifications",
  "plan", "plans", "planning", "design", "designs", "decisions", "adr", "adrs",
  "rfc", "rfcs", "requirements", "notes", "reference", "references", "handoff",
  "deliverables", "proposals", "architecture",
]);

/** True when this path is somewhere a project document is expected to live. */
function looksLikeProjectDocument(relative: string, governance: DocumentGovernance): boolean {
  const segments = relative.split("/");
  // At the project root: README-v2.md next to the code is a project document,
  // and the repository's own files are excluded by name elsewhere.
  if (segments.length === 1) return true;
  if (governance.directories.some((directory) => directory && relative.startsWith(`${directory}/`))) return true;
  return segments.slice(0, -1).some((segment) => DOCUMENT_DIRECTORIES.has(segment.toLowerCase()));
}

const VERSIONED_DOCUMENT = /-v\d+\.md$/i;

interface DocumentGovernance {
  directories: string[];
  exclusions: string[];
  /** Markdown present when the project was initialised. Absent on old projects. */
  preexisting: string[] | null;
}

function documentGovernance(state: State): DocumentGovernance {
  const recorded = (state as any).document_governance;
  const directories = Array.isArray(recorded?.directories) && recorded.directories.length
    ? recorded.directories.map((entry: unknown) => canonicalRelative(String(entry)).replace(/\/+$/, ""))
    : DEFAULT_GOVERNED_DIRECTORIES;
  const exclusions = Array.isArray(recorded?.exclusions)
    ? recorded.exclusions.map((entry: unknown) => canonicalRelative(String(entry)))
    : [];
  const preexisting = Array.isArray(recorded?.preexisting)
    ? recorded.preexisting.map((entry: unknown) => canonicalRelative(String(entry)))
    : null;
  return { directories, exclusions, preexisting };
}

/**
 * Every Markdown file in the project, as paths relative to the root.
 *
 * Bounded on purpose: it skips the ledger, dependency and build directories, and
 * anything starting with a dot. A project big enough for this to be slow is a
 * project where walking `node_modules` would have been the slow part.
 */
function markdownFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (directory: string, prefix: string, depth: number): void => {
    if (depth > 12) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const name = entry.name;
      if (name.startsWith(".")) continue;
      const relative = prefix ? `${prefix}/${name}` : name;
      if (entry.isDirectory()) {
        if (UNSCANNED_DIRECTORIES.has(name.toLowerCase()) || isReservedTop(name)) continue;
        walk(path.join(directory, name), relative, depth + 1);
      } else if (entry.isFile() && name.toLowerCase().endsWith(".md")) {
        found.push(relative);
      }
    }
  };
  walk(root, "", 0);
  return found.sort();
}

/** True when a recorded exclusion covers this path, exactly or as a subtree. */
function excludedFromGovernance(relative: string, exclusions: string[]): boolean {
  return exclusions.some((pattern) => {
    if (!pattern) return false;
    if (pattern.endsWith("/**")) return relative.startsWith(pattern.slice(0, -2));
    if (pattern.endsWith("/")) return relative.startsWith(pattern);
    return relative === pattern;
  });
}

interface UnclaimedDocument {
  path: string;
  tier: "versioned" | "governed-directory";
}

/**
 * Markdown the project looks like it should be governing, and is not.
 *
 * Claimed means an artifact names it, in either of the two paths an artifact
 * carries: the working `-vN` file and the finalized base file. The interview
 * view is claimed by being the interview view.
 */
function unclaimedDocuments(root: string, state: State): UnclaimedDocument[] {
  const governance = documentGovernance(state);
  const claimed = new Set<string>();
  for (const artifact of state.artifacts ?? []) {
    for (const value of [artifact.working_path, artifact.base_path]) {
      if (nonEmpty(value)) claimed.add(canonicalRelative(String(value)));
    }
  }
  const view = (state as any).interview_view?.path;
  if (nonEmpty(view)) claimed.add(canonicalRelative(String(view)));
  /*
   * A document is claimed by any record that carries its digest, not only by an
   * artifact.
   *
   * Found on the pilot fixture: an override's instruction file and a
   * reconciliation's evidence, both recorded with a digest that `validate`
   * re-verifies on every run, were reported as documents nobody was governing.
   * They are among the most governed files in the project. Reporting them makes
   * the warning wrong in exactly the way that teaches a reader to skip it.
   */
  for (const item of state.human_overrides ?? []) {
    for (const value of [(item as any).source, (item as any).reconciliation_evidence]) {
      if (nonEmpty(value)) claimed.add(canonicalRelative(String(value)));
    }
    for (const previous of (item as any).source_history ?? []) {
      if (nonEmpty(previous?.path)) claimed.add(canonicalRelative(String(previous.path)));
    }
  }
  for (const item of state.gates ?? []) {
    if (nonEmpty((item as any).evidence)) claimed.add(canonicalRelative(String((item as any).evidence)));
  }
  for (const item of state.modules ?? []) {
    if (nonEmpty(item.evidence)) claimed.add(canonicalRelative(String(item.evidence)));
  }
  for (const item of state.evidence ?? []) {
    const value = typeof item === "string" ? item : (item as any)?.path;
    if (nonEmpty(value)) claimed.add(canonicalRelative(String(value)));
  }
  for (const item of state.blockers ?? []) {
    for (const value of [(item as any)?.evidence, (item as any)?.resolution_evidence]) {
      if (nonEmpty(value)) claimed.add(canonicalRelative(String(value)));
    }
  }

  const preexisting = new Set(governance.preexisting ?? []);
  const inGoverned = (relative: string) =>
    governance.directories.some((directory) => directory && relative.startsWith(`${directory}/`));

  const found: UnclaimedDocument[] = [];
  for (const relative of markdownFiles(root)) {
    if (claimed.has(relative)) continue;
    if (excludedFromGovernance(relative, governance.exclusions)) continue;
    const basename = path.basename(relative).replace(/\.md$/i, "").toLowerCase();
    if (UNGOVERNED_BASENAMES.has(basename)) continue;
    if (VERSIONED_DOCUMENT.test(relative)) {
      // Two bounds this tier did not have, and both were false positives waiting
      // to happen: a working file buried in application code is not a project
      // deliverable, and a -vN.md that was in the folder before `init` is not an
      // agent's mistake -- the second tier had always known that and this one
      // had not.
      if (!looksLikeProjectDocument(relative, governance)) continue;
      if (preexisting.has(relative)) continue;
      found.push({ path: relative, tier: "versioned" });
      continue;
    }
    // The second tier needs a record of what was already there. Without one it
    // would report a project's existing documentation as an agent's mistake.
    if (governance.preexisting === null) continue;
    if (preexisting.has(relative)) continue;
    if (inGoverned(relative)) found.push({ path: relative, tier: "governed-directory" });
  }
  return found;
}

/**
 * The report: the findings, and separately the instructions for acting on them.
 *
 * Two lists rather than one, because the caller renders findings as a bulleted
 * refusal and instructions are not findings. Bulleted together, the count of
 * problems silently included the paragraph explaining how to fix them.
 */
function unclaimedDocumentReport(root: string, state: State): { findings: string[]; remedy: string[] } {
  const found = unclaimedDocuments(root, state);
  if (!found.length) return { findings: [], remedy: [] };
  const findings = found.map((entry) =>
    entry.tier === "versioned"
      ? `${entry.path} carries a -vN working-file name and no artifact claims it, so it has no digest and can be changed without anything noticing.`
      : `${entry.path} is a Markdown file inside a governed directory, written after this project was initialised, and no artifact claims it.`
  );
  const first = found[0].path;
  const base = first.replace(/-v\d+\.md$/i, ".md");
  return {
    findings,
    remedy: [
      `Regularise each one by recording it. Two commands: the first shows what would be written and returns a confirmation_token, the second writes it.`,
      `  plangonaut doc-diff --project-root . --id ART-<NAME> --base-path ${base} --content-file ${first} --owner <owner>`,
      `  plangonaut doc-save --project-root . --id ART-<NAME> --base-path ${base} --content-file ${first} --owner <owner> --confirm-token <confirmation_token from doc-diff> --operation-id <id>`,
      `A file that is deliberately not governed is declared, not ignored: plangonaut govern --project-root . --exclude <path> --reason "<why>" --owner <owner> --operation-id <id>.`,
    ],
  };
}

/**
 * Directories whose copies are output, not documents.
 *
 * A build puts the same bytes in three places by design, and reporting each as
 * a duplicate is how a check becomes noise somebody filters out. These are
 * excluded by path rather than by guessing from content, because content is
 * exactly what is identical in the legitimate case.
 */
const DERIVED_DIRECTORIES = /(^|\/)(dist|build|out|node_modules|target|\.git|coverage|vendor|assets\/generated)(\/|$)/i;

/**
 * Two files with the same content, when one of them is the record.
 *
 * The pilot had a governed document and an ungoverned copy of it, and nothing
 * noticed. A recipient reading the folder finds both and has no way to know
 * which one the project means — and the ledger *does* know, because one of them
 * carries a digest and an artifact id and the other does not.
 *
 * So this never asks the user which to delete when the ledger can answer, and
 * it never deletes anything: governed documents have a lifecycle
 * (`doc-finalize`, and a superseded status that points at its replacement) and
 * a check is not entitled to shortcut it.
 */
function duplicateDocumentFindings(root: string, state: State): string[] {
  const findings: string[] = [];

  const governed = new Map<string, string>(); // canonical path -> artifact id
  for (const artifact of state.artifacts ?? []) {
    for (const value of [artifact.working_path, artifact.base_path]) {
      if (nonEmpty(value)) governed.set(canonicalRelative(String(value)), artifact.id);
    }
  }

  const byDigest = new Map<string, string[]>();
  const walk = (directory: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = canonicalRelative(path.relative(root, absolute));
      if (DERIVED_DIRECTORIES.test(relative)) continue;
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (!/\.(md|markdown|txt)$/i.test(entry.name)) continue;
      let bytes: Buffer;
      try {
        bytes = fs.readFileSync(absolute);
      } catch {
        continue;
      }
      // Empty files are identical to each other and mean nothing by it.
      if (!bytes.length) continue;
      const digest = sha256(bytes);
      const list = byDigest.get(digest) ?? [];
      list.push(relative);
      byDigest.set(digest, list);
    }
  };
  walk(root);

  for (const [, paths] of byDigest) {
    if (paths.length < 2) continue;
    const sorted = [...paths].sort();
    const governedPaths = sorted.filter((item) => governed.has(item));
    const ungoverned = sorted.filter((item) => !governed.has(item));

    // One artifact's own paths are not a duplicate of each other.
    const distinctArtifacts = new Set(governedPaths.map((item) => governed.get(item)));
    if (distinctArtifacts.size === 1 && ungoverned.length) {
      /*
       * Named by artifact, not by path.
       *
       * One artifact can hold a base path and a working path, and picking
       * whichever sorts first would make the message arbitrary — the engine
       * would say `architecture-v1.md` today and `architecture.md` after a
       * finalize, describing the same record both times.
       */
      const artifact = governed.get(governedPaths[0]);
      const keep = governedPaths.join(" / ");
      findings.push(
        `${ungoverned.join(", ")} ${ungoverned.length === 1 ? "is a byte-for-byte copy" : "are byte-for-byte copies"} of ${keep}, which artifact ${artifact} governs. ` +
        `A recipient finds both and cannot tell which one the project means; the ledger can, and it is ${artifact}. ` +
        `Close it by archiving or reconciling the ${ungoverned.length === 1 ? "copy" : "copies"} — this check does not delete a governed document and does not ask which to keep, because the answer is recorded.`
      );
    } else if (governedPaths.length > 1 && new Set(governedPaths.map((item) => governed.get(item))).size > 1) {
      /*
       * Two artifacts, not one artifact's two paths.
       *
       * A governed document has a base path and a working path, and after a
       * `doc-save` they hold the same bytes by construction — that is what
       * saving means. Reporting that pair was the first thing this check did,
       * and it is the kind of false positive that teaches a reader to skip the
       * whole finding.
       */
      findings.push(
        `${governedPaths.join(" and ")} hold identical content and are governed separately (${governedPaths.map((item) => governed.get(item)).join(", ")}). ` +
        `Two records of one document will diverge the first time somebody edits the one they happened to open. Finalize one and supersede the other, preserving both histories.`
      );
    } else {
      findings.push(
        `${sorted.join(", ")} hold identical content and none of them is governed, so the project has two copies of something and no record of which is current.`
      );
    }
  }

  return findings;
}

function validateRoot(root: string, includeDocuments = false): State {
  const { state } = loadState(root);
  const errors = stateErrors(root, state);
  if (includeDocuments && !errors.length) errors.push(...documentIntegrityErrors(root, state));
  if (includeDocuments && !errors.length) errors.push(...interviewViewErrors(root, state));
  if (errors.length) throw new PlangonautError(`Validation failed:\n- ${errors.join("\n- ")}`, "PROJECT_STATE_UNTRUSTED");
  return state;
}

/**
 * What is actually known about this project's blockers.
 *
 * `status --json` reported `"blockers": []`, which in every language a consumer
 * is written in means *there are none*. The truth was narrower and less
 * comforting: no command writes that ledger, so the array was empty in exactly
 * the same way for a project with no blockers and for a project with ten that
 * nobody had a way to record. `resume` said so in words and the machine-readable
 * output did not, which is the wrong way round — a person reading a paragraph
 * can notice a caveat, a program reading an array cannot.
 *
 * So the absence of knowledge has its own shape. `blockers` is `null` when
 * nothing authoritative is known, and the two companion fields say why:
 *
 *   RECORDED    entries exist in the ledger; `blockers` is that array
 *   NONE_VERIFIED  something checked and found none (no command does this today)
 *   UNKNOWN     nothing writes this ledger, so its emptiness proves nothing
 *   UNTRUSTED   the state does not agree with its history
 *
 * `UNTRUSTED` is unreachable from this command, which refuses such a project
 * outright; it is in the vocabulary because a consumer that handles four values
 * does not break the day a fifth caller can return it. `NONE_VERIFIED` is
 * unreachable today and is named so that "verified none" and "nobody looked"
 * cannot collapse into each other later. `ALN-015` holds the writable ledger.
 */
function blockerAssurance(state: State): {
  blockers: (string | Blocker)[] | null;
  blockers_recorded: boolean;
  open_blockers: number;
  blockers_assurance: string;
  blockers_verified_none: BlockerVerification | null;
  blockers_note: string;
} {
  const entries = blockerEntries(state);
  const open = openBlockers(state);
  const verification = state.blockers_none_verified ?? null;

  if (open.length) {
    return {
      blockers: entries,
      blockers_recorded: true,
      open_blockers: open.length,
      blockers_assurance: "RECORDED",
      blockers_verified_none: null,
      blockers_note:
        "These are the entries in the ledger. RECORDED means they are what was written down, not that they are every blocker the project has.",
    };
  }

  if (verification) {
    return {
      blockers: entries.length ? entries : null,
      blockers_recorded: entries.length > 0,
      open_blockers: 0,
      blockers_assurance: "NONE_VERIFIED",
      blockers_verified_none: verification,
      blockers_note: `${verification.by} verified at ${verification.at}, against revision ${verification.state_revision}, that no blocker was open. Recording or resolving one clears this, because a verification is a statement about one state of the ledger.`,
    };
  }

  if (entries.length) {
    return {
      blockers: entries,
      blockers_recorded: true,
      open_blockers: 0,
      blockers_assurance: "UNKNOWN",
      blockers_verified_none: null,
      blockers_note:
        "Every recorded blocker is resolved, and nobody has verified since that none is open. Resolving the last one is not the same statement as looking and finding none: record that with `plangonaut blocker-verify-none`.",
    };
  }

  return {
    blockers: null,
    blockers_recorded: false,
    open_blockers: 0,
    blockers_assurance: "UNKNOWN",
    blockers_verified_none: null,
    blockers_note:
      "Nothing is recorded and nobody has verified that nothing is open. An empty ledger is not evidence of an unblocked project: record what you find with `plangonaut blocker-record`, or record the absence with `plangonaut blocker-verify-none`. `blockers` is null rather than [] because an empty list would read as a verified absence.",
  };
}

/**
 * Where a blocker command starts: lock, idempotency, state, owner.
 *
 * Shared by the three so they cannot drift apart on the things that must be the
 * same — and `assertNotBlocked` is deliberately **not** among them. A project
 * awaiting reconciliation is exactly a project somebody needs to record a
 * blocker against; refusing the record because the project is blocked would be
 * the ledger refusing the only entry it exists for.
 */
function blockerCommandStart(flags: Flags): { root: string; key: string; location: string; state: State; owner: string; timestamp: string } | null {
  const root = resolveProject(required(flags, "project-root"));
  const key = idempotencyKey(flags);
  if (checkIdempotency(root, key)) return null;
  const { location, state } = loadState(root);
  const owner = required(flags, "owner").trim();
  assertKnownOwner(state, owner);
  return { root, key, location, state, owner, timestamp: now() };
}

/** Commit one blocker mutation. Every one of them clears a stale verification. */
function commitBlocker(
  root: string,
  location: string,
  state: State,
  key: string,
  type: string,
  timestamp: string,
  owner: string,
  extra: Record<string, unknown>,
): void {
  state.updated_at = timestamp;
  const revision = state.revision + 1;
  const eventId = crypto.randomUUID();
  state.revision = revision;
  state.last_event_id = eventId;
  commitState(root, location, state, {
    event_id: eventId,
    type,
    state_revision: revision,
    at: timestamp,
    idempotency_key: key,
    owner,
    ...extra,
  });
}

/**
 * Record a blocker, or update one that is already there.
 *
 * `--expected-revision` is required to touch an existing record, exactly as it
 * is for every other ledger: two people editing the same blocker from two
 * checkouts is the case it exists for.
 */
function blockerRecord(flags: Flags): void {
  const started = blockerCommandStart(flags);
  if (!started) return console.log("Idempotent retry: blocker already recorded.");
  const { root, key, location, state, owner, timestamp } = started;

  const id = required(flags, "id").toUpperCase();
  if (!validTypedId(id, "BLK")) throw new PlangonautError(`Invalid blocker ID: ${id}. Expected BLK- followed by uppercase letters, numbers, _ or -.`);
  const title = required(flags, "title").trim();
  if (!title) throw new PlangonautError(`--title cannot be empty`);
  const reason = required(flags, "reason").trim();
  if (!reason) throw new PlangonautError(`--reason cannot be empty`);

  const records = blockerRecords(state);
  const existing = records.find((item) => item.id === id);
  if (existing) {
    const expected = Number(required(flags, "expected-revision"));
    if (!Number.isInteger(expected) || expected !== existing.revision) {
      throw new PlangonautError(`Stale blocker ${id}: expected revision ${existing.revision}. No changes written.`);
    }
    if (existing.status === "RESOLVED") {
      throw new PlangonautError(
        `Blocker ${id} is resolved. Reopening it by overwriting the record would erase how it was closed; record the new obstacle as its own blocker instead. Nothing was written.`,
      );
    }
  }

  let evidence: { path: string; sha256: string } | undefined;
  if (typeof flags["evidence-file"] === "string") {
    const verified = verifiedEvidence(root, path.resolve(String(flags["evidence-file"])));
    evidence = { path: verified.relative.replaceAll("\\", "/"), sha256: verified.hash };
  }

  const record: Blocker = {
    id,
    title,
    reason,
    status: "OPEN",
    owner,
    recorded_at: existing?.recorded_at ?? timestamp,
    ...(evidence ? { evidence } : {}),
    revision: (existing?.revision ?? 0) + 1,
    updated_at: timestamp,
  };

  if (existing) Object.assign(existing, record);
  else (state.blockers as (string | Blocker)[]).push(record);

  // An open blocker and a verification that none is open cannot both stand.
  state.blockers_none_verified = null;

  commitBlocker(root, location, state, key, existing ? "BLOCKER_UPDATED" : "BLOCKER_RECORDED", timestamp, owner, {
    ledger_id: id,
    record_revision: record.revision,
    record_status: record.status,
  });
  console.log(`${existing ? "Updated" : "Recorded"} blocker ${id} at revision ${record.revision}`);
}

/**
 * Close a blocker without losing it.
 *
 * The record stays and gains how it ended. A `RESOLVED` blocker is history, and
 * history is the thing a ledger is for: `resume` and the context pack still show
 * it, and `open_blockers` stops counting it.
 */
function blockerResolve(flags: Flags): void {
  const started = blockerCommandStart(flags);
  if (!started) return console.log("Idempotent retry: blocker already resolved.");
  const { root, key, location, state, owner, timestamp } = started;

  const id = required(flags, "id").toUpperCase();
  const existing = blockerRecords(state).find((item) => item.id === id);
  if (!existing) {
    const known = blockerRecords(state).map((item) => item.id);
    throw new PlangonautError(
      `No blocker ${id} is recorded${known.length ? `. Recorded: ${known.join(", ")}` : " in this project"}. ` +
        `A blocker written as free text before the ledger existed has no id and cannot be resolved by one: record it with \`plangonaut blocker-record\` first, so that closing it leaves a trace. Nothing was written.`,
    );
  }
  if (existing.status === "RESOLVED") {
    throw new PlangonautError(`Blocker ${id} was already resolved by ${existing.resolved_by} at ${existing.resolved_at}. Nothing was written.`);
  }
  const expected = Number(required(flags, "expected-revision"));
  if (!Number.isInteger(expected) || expected !== existing.revision) {
    throw new PlangonautError(`Stale blocker ${id}: expected revision ${existing.revision}. No changes written.`);
  }
  const resolution = required(flags, "resolution").trim();
  if (!resolution) throw new PlangonautError(`--resolution cannot be empty`);

  if (typeof flags["evidence-file"] === "string") {
    const verified = verifiedEvidence(root, path.resolve(String(flags["evidence-file"])));
    existing.evidence = { path: verified.relative.replaceAll("\\", "/"), sha256: verified.hash };
  }

  existing.status = "RESOLVED";
  existing.resolution = resolution;
  existing.resolved_by = owner;
  existing.resolved_at = timestamp;
  existing.revision += 1;
  existing.updated_at = timestamp;

  /*
   * Resolving the last open blocker does not verify that none is open.
   *
   * It is a statement about one blocker; "there are none" is a statement about
   * the project, and somebody has to make it. Clearing the marker here keeps the
   * two apart — which is why the required path is RECORDED → UNKNOWN, and
   * NONE_VERIFIED only after somebody says so.
   */
  state.blockers_none_verified = null;

  commitBlocker(root, location, state, key, "BLOCKER_RESOLVED", timestamp, owner, {
    ledger_id: id,
    record_revision: existing.revision,
    record_status: existing.status,
  });
  console.log(`Resolved blocker ${id} at revision ${existing.revision}. The record is kept.`);
}

/**
 * Put a name to "I looked, and nothing is open".
 *
 * Refused while anything is open, because it would be false. This is the only
 * route to `NONE_VERIFIED`, and it is a mutation with an owner and an event for
 * the same reason every other assertion in this engine is: an unattributed
 * claim of absence is exactly what `[]` used to be.
 */
function blockerVerifyNone(flags: Flags): void {
  const started = blockerCommandStart(flags);
  if (!started) return console.log("Idempotent retry: the absence of open blockers is already recorded.");
  const { root, key, location, state, owner, timestamp } = started;

  const open = openBlockers(state);
  if (open.length) {
    throw new PlangonautError(
      `${open.length} blocker${open.length === 1 ? " is" : "s are"} open, so "none is open" cannot be recorded:\n- ${open.map(blockerLine).join("\n- ")}\n` +
        `Resolve them with \`plangonaut blocker-resolve\` first. Nothing was written.`,
    );
  }

  const note = typeof flags.note === "string" ? String(flags.note).trim() : "";
  const eventId = crypto.randomUUID();
  state.blockers_none_verified = {
    at: timestamp,
    by: owner,
    state_revision: state.revision + 1,
    event_id: eventId,
    ...(note ? { note } : {}),
  };
  state.updated_at = timestamp;
  const revision = state.revision + 1;
  state.revision = revision;
  state.last_event_id = eventId;
  commitState(root, location, state, {
    event_id: eventId,
    type: "BLOCKERS_VERIFIED_NONE",
    state_revision: revision,
    at: timestamp,
    idempotency_key: key,
    owner,
    ...(note ? { note } : {}),
  });
  console.log(`Recorded: ${owner} verified at revision ${revision} that no blocker is open.`);
}

/**
 * Declare whether this project is meant to be built.
 *
 * A human authority's statement, recorded like any other. The engine will not
 * infer it, and this is the command that exists so that it never has to: a
 * feasibility study and an unfinished project are indistinguishable from the
 * outside, and the only thing that can tell them apart is somebody saying so.
 */
function executionIntent(flags: Flags): void {
  const root = resolveProject(required(flags, "project-root"));
  const key = idempotencyKey(flags);
  if (checkIdempotency(root, key)) return console.log("Idempotent retry: the execution intent is already recorded.");
  const { location, state } = loadState(root);
  assertNotBlocked(state);
  const owner = required(flags, "owner").trim();
  assertKnownOwner(state, owner);

  const definitionOnly = flags["definition-only"] === true;
  const execution = flags.execution === true;
  if (definitionOnly === execution) {
    throw new PlangonautError(
      `Give exactly one of --definition-only or --execution.\n` +
      `  --execution        the project is to be built, and execution readiness applies.\n` +
      `  --definition-only  the deliverable is the definition itself: a study, a proposal, a concept note, a tender.\n` +
      `Nothing was written.`,
    );
  }
  const reason = required(flags, "reason").trim();
  if (!reason) throw new PlangonautError(`--reason cannot be empty. A mode nobody explained is a mode nobody can question later.`);

  const previous = state.execution_intent ?? null;
  const mode = definitionOnly ? "DEFINITION_ONLY" : "EXECUTION";
  const timestamp = now();
  const eventId = crypto.randomUUID();
  state.execution_intent = { mode, reason, declared_by: owner, declared_at: timestamp, operation_id: String(flags["operation-id"] ?? "") };
  state.updated_at = timestamp;
  const revision = state.revision + 1;
  state.revision = revision;
  state.last_event_id = eventId;
  commitState(root, location, state, {
    event_id: eventId,
    type: "EXECUTION_INTENT_DECLARED",
    state_revision: revision,
    at: timestamp,
    idempotency_key: key,
    owner,
    mode,
    reason,
    ...(previous ? { previous_mode: previous.mode } : {}),
  });

  if (previous && previous.mode !== mode) {
    console.log(`Changed: ${previous.mode} -> ${mode}, by ${owner} at revision ${revision}.`);
  } else {
    console.log(`Recorded: ${mode}, by ${owner} at revision ${revision}.`);
  }
  if (mode === "DEFINITION_ONLY") {
    console.log(`\nDefinition complete.\nExecution readiness not requested.\nThis folder is not an execution package.`);
    console.log(`\nThat is a statement about intent, not about quality: the definition is still held to its own completeness.`);
  } else {
    console.log(`\nExecution readiness now applies. plangonaut execution-readiness --project-root . says where it stands.`);
  }
}

/**
 * Record the approved organisation of whoever executes the work.
 *
 * The proposal is not made here. A configuration is something to be *proposed*
 * — by whoever has read the decomposition and can see what is independent of
 * what — and then approved or changed by a person. Asking a user to invent the
 * number of executors from nothing is asking them to do the analysis the tool
 * was supposed to do. This command records the end of that exchange.
 *
 * One executor is a legitimate answer and does not make the rest optional. The
 * questions of who reviews, when work is handed over and what stops it are the
 * same questions with a smaller cast.
 */
function executionOrg(flags: Flags): void {
  const root = resolveProject(required(flags, "project-root"));
  const key = idempotencyKey(flags);
  if (checkIdempotency(root, key)) return console.log("Idempotent retry: this organisation is already recorded.");
  const { location, state } = loadState(root);
  assertNotBlocked(state);
  const owner = required(flags, "owner").trim();
  assertKnownOwner(state, owner);

  const executors = Number(required(flags, "executors"));
  if (!Number.isInteger(executors) || executors < 1) {
    throw new PlangonautError(`--executors must be a whole number of one or more. Nothing was written.`);
  }
  const mode = required(flags, "mode").trim();
  const concurrency = required(flags, "concurrency").trim();
  const handoff = required(flags, "handoff").trim();
  const integrator = typeof flags.integrator === "string" ? String(flags.integrator).trim() : null;
  const reviewer = typeof flags.reviewer === "string" ? String(flags.reviewer).trim() : null;

  if (executors > 1 && !integrator) {
    throw new PlangonautError(
      `${executors} executors and no --integrator.\n` +
      `Two executors producing correct halves is not one working thing, and nothing in the folder would say whose job it is to make it so.\n` +
      `Name one, or record a single executor. Nothing was written.`,
    );
  }
  if (!reviewer) {
    throw new PlangonautError(
      `--reviewer is missing.\n` +
      `Somebody has to check the work, including when that somebody is the person who did it — in which case name them, and the folder records that review is unindependent rather than absent.\n` +
      `Nothing was written.`,
    );
  }

  const timestamp = now();
  const eventId = crypto.randomUUID();
  state.execution_organization = {
    executors,
    mode,
    integrator: integrator || null,
    reviewer,
    concurrency,
    handoff,
    approved_by: owner,
    approved_at: timestamp,
    operation_id: String(flags["operation-id"] ?? ""),
  };
  state.updated_at = timestamp;
  const revision = state.revision + 1;
  state.revision = revision;
  state.last_event_id = eventId;
  commitState(root, location, state, {
    event_id: eventId,
    type: "EXECUTION_ORGANIZATION_APPROVED",
    state_revision: revision,
    at: timestamp,
    idempotency_key: key,
    owner,
    executors,
    mode,
  });
  console.log(`Recorded: ${executors} executor${executors === 1 ? "" : "s"} (${mode}), approved by ${owner} at revision ${revision}.`);
  if (executors === 1) {
    console.log(`\nOne executor still has a plan: ${reviewer} reviews, and work is handed over ${handoff}.`);
  }
}

/**
 * Record that a file was read, and what was concluded from it.
 *
 * The pilot produced one turn in which the agent said it had read two files in
 * full, and a later turn in which it said nobody had ever read them. Both were
 * claims about the past, neither had anything behind it, and the project had no
 * way to prefer one over the other.
 *
 * The digest is what makes this different from a claim. A recorded read can be
 * checked against the file as it is now: still the same, changed since, or
 * gone. `resume` reports which, and none of the three is "the agent said so".
 */
function readRecord(flags: Flags): void {
  const root = resolveProject(required(flags, "project-root"));
  const key = idempotencyKey(flags);
  if (checkIdempotency(root, key)) return console.log("Idempotent retry: this read is already recorded.");
  const { location, state } = loadState(root);
  assertNotBlocked(state);
  const owner = required(flags, "owner").trim();
  assertKnownOwner(state, owner);

  const relative = canonicalRelative(required(flags, "path"));
  const absolute = path.resolve(root, relative);
  if (!absolute.startsWith(path.resolve(root))) {
    throw new PlangonautError(`${relative} is outside the project. A read of something the recipient cannot open is not evidence about this folder. Nothing was written.`);
  }
  if (!fs.existsSync(absolute)) {
    throw new PlangonautError(`${relative} does not exist, so it was not read. Nothing was written.`);
  }
  const digest = sha256(fs.readFileSync(absolute));
  const purpose = required(flags, "purpose").trim();
  if (!purpose) throw new PlangonautError(`--purpose cannot be empty. A read with no purpose is a file access, not evidence.`);
  const agent = typeof flags.agent === "string" ? String(flags.agent).trim() : owner;
  const conclusions = typeof flags.conclusions === "string" ? String(flags.conclusions).trim() : "";
  const usedBy = typeof flags["used-by"] === "string" ? String(flags["used-by"]).split(",").map((item) => item.trim().toUpperCase()).filter(Boolean) : [];

  const known = knownRecordIds(state);
  const unknown = usedBy.filter((id) => !known.has(id));
  if (unknown.length) {
    throw new PlangonautError(`--used-by names ${unknown.join(", ")}, which no record answers to. Nothing was written.`);
  }

  const timestamp = now();
  const eventId = crypto.randomUUID();
  const reads = (state.reads ??= []);
  const id = `RDR-${String(reads.length + 1).padStart(4, "0")}`;
  reads.push({
    id,
    path: relative,
    sha256: digest,
    read_at: timestamp,
    agent,
    purpose,
    ...(conclusions ? { conclusions } : {}),
    ...(usedBy.length ? { used_by: usedBy } : {}),
    owner,
    revision: 1,
    updated_at: timestamp,
  });
  state.updated_at = timestamp;
  const revision = state.revision + 1;
  state.revision = revision;
  state.last_event_id = eventId;
  commitState(root, location, state, {
    event_id: eventId,
    type: "FILE_READ_RECORDED",
    state_revision: revision,
    at: timestamp,
    idempotency_key: key,
    owner,
    path: relative,
    sha256: digest,
  });
  console.log(`Recorded ${id}: ${agent} read ${relative} (${digest.slice(0, 12)}) for ${purpose}.`);
}

/**
 * What a recorded read is worth now.
 *
 * Four outcomes, and the difference between the last two is the whole point:
 * a file nobody recorded reading is not the same as a file somebody read and
 * then changed. The first is an absence of evidence; the second is evidence
 * that has expired.
 */
type ReadStanding = "PROVED" | "CHANGED SINCE" | "MISSING" | "NO EVIDENCE";

function readStandings(root: string, state: State): { record: ReadRecord; standing: ReadStanding }[] {
  return (state.reads ?? []).map((record) => {
    const absolute = path.resolve(root, record.path);
    if (!fs.existsSync(absolute)) return { record, standing: "MISSING" as ReadStanding };
    const digest = sha256(fs.readFileSync(absolute));
    return { record, standing: (digest === record.sha256 ? "PROVED" : "CHANGED SINCE") as ReadStanding };
  });
}

/**
 * The execution readiness check, on its own, for a caller who wants only that.
 *
 * Also the command every other reader points at, so that a person told
 * "execution readiness: failed" has somewhere to go that explains it.
 */
function executionReadinessCommand(flags: Flags): void {
  const root = resolveProject(required(flags, "project-root"));
  const state = validateRoot(root);
  const report = readinessReport(state, root);

  if (flags.json === true) {
    console.log(JSON.stringify({
      intent: report.intent,
      definition: { verdict: report.definition.verdict, findings: report.definition.findings },
      execution: { verdict: report.execution.verdict, findings: report.execution.findings },
    }, null, 2));
    if (report.execution.verdict === "FAILED") reportedExitCode = 2;
    return;
  }

  console.log(readinessLines(report, "NOT ASSESSED").slice(0, 2).join("\n"));
  if (report.definition.findings.length) {
    console.log(`\nDefinition:`);
    for (const line of report.definition.findings) console.log(`- ${line}`);
  }
  if (report.execution.findings.length) {
    console.log(`\nExecution readiness:`);
    for (const line of report.execution.findings) console.log(`- ${line}`);
  }
  if (report.execution.remedy.length) console.log(`\n${report.execution.remedy.join("\n")}`);
  if (report.execution.verdict === "FAILED") {
    reportedExitCode = 2;
  }
}

// ---------------------------------------------------------------------------
// What a writer can do, and what a project needs from one
// ---------------------------------------------------------------------------

/*
 * A version number is not a capability.
 *
 * Studio 0.3.0-alpha.4 wrote a `DOCUMENT_SAVED` event into a project the
 * alpha.5 CLI governs. The event carried an id, a type, a revision and a
 * timestamp, and none of `format`, `state_patch`, `previous_state_sha256`,
 * `state_sha256`, `previous_event_sha256` or `payload_sha256`. It was a
 * perfectly good event in the format its writer knew, appended to a history
 * that had moved on, and nothing anywhere compared the two.
 *
 * Comparing the version numbers would not have helped either. `alpha.4 < alpha.5`
 * says nothing about whether the older writer produces events the newer reader
 * can replay — it might, for a release that changed nothing about the format,
 * and it might not, for a patch release that changed everything. What decides it
 * is what each side can actually do, so each side says so.
 */

/** The event shapes this engine can read. Historical formats stay readable. */
const READABLE_EVENT_FORMATS = [1, 2];

/**
 * The digest and patch fields a format-2 event carries.
 *
 * Listed here rather than inferred from a sample, because the failure this
 * closes is a writer producing an event that *looks* complete. A reader that
 * derives the required set from whatever it happens to be holding cannot
 * detect the absence of a field nothing in front of it has.
 */
const FORMAT_2_REQUIRED = [
  "format",
  "state_patch",
  "previous_revision",
  "previous_state_sha256",
  "state_sha256",
  "previous_event_sha256",
  "payload_sha256",
];

interface WriterCapabilities {
  /** What this engine is. */
  engine: string;
  version: string;
  schema_version: number;
  /** Event formats it can read. */
  reads_event_formats: number[];
  /** The single format it writes. A writer that writes two is a writer nobody can predict. */
  writes_event_format: number;
  /** Whether it can rebuild a state from its history. */
  replay: boolean;
  /** Governed mutations it implements. */
  governed_operations: string[];
}

function writerCapabilities(): WriterCapabilities {
  return {
    engine: "plangonaut-cli",
    version: VERSION,
    schema_version: SCHEMA_VERSION,
    reads_event_formats: READABLE_EVENT_FORMATS,
    writes_event_format: EVENT_FORMAT,
    replay: true,
    governed_operations: ["doc-save", "doc-finalize", "doc-restore", "doc-mark-deletion"],
  };
}

interface ProjectRequirements {
  schema_version: number;
  /** The highest event format found in this project's history. */
  event_format: number;
  /** Every format present, because a mixed history is a fact worth stating. */
  event_formats_present: number[];
  /** The engine that wrote the last event, when it recorded one. */
  last_engine_version: string | null;
  /** The minimum a writer must produce to append to this history without breaking it. */
  minimum_writer_event_format: number;
  /** Events whose shape their own declared format does not satisfy. */
  malformed_events: number;
}

/**
 * What a project needs from anything that writes to it.
 *
 * Derived from the history rather than from the state, because the history is
 * what a new event has to be consistent with. A project whose last event is
 * format 2 cannot accept a format-1 event: the chain would break at that line
 * and every later event would be unverifiable.
 */
function projectRequirements(root: string): ProjectRequirements {
  const events = readEvents(root);
  const formats = new Set<number>();
  let malformed = 0;
  /*
   * A format that goes backwards is the defect, not a format that is old.
   *
   * A history entirely in format 1 is a project from before the format existed,
   * and is fine. A format-1 event *after* a format-2 one is a second writer
   * that did not know: the line is readable and records no mutation, so
   * everything from there on stops being replayable. Tracking the highest
   * format seen so far is what tells those two apart.
   */
  let highestSoFar = 0;
  for (const event of events) {
    const format = Number(event?.format ?? 1);
    formats.add(format);
    if (format >= 2) {
      const missing = FORMAT_2_REQUIRED.filter((field) => event?.[field] === undefined);
      if (missing.length) malformed += 1;
    } else if (format < highestSoFar) {
      malformed += 1;
    }
    if (format > highestSoFar) highestSoFar = format;
  }
  const present = [...formats].sort((a, b) => a - b);
  const highest = present.length ? present[present.length - 1] : EVENT_FORMAT;
  const { state } = (() => {
    try {
      return loadState(root);
    } catch {
      return { state: null as any };
    }
  })();
  return {
    schema_version: Number(state?.schema_version ?? SCHEMA_VERSION),
    event_format: highest,
    event_formats_present: present,
    last_engine_version: nonEmpty(state?.last_engine_version) ? String(state.last_engine_version) : null,
    minimum_writer_event_format: highest,
    malformed_events: malformed,
  };
}

export interface CompatibilityVerdict {
  compatible: boolean;
  /** Why not, in the order found. */
  reasons: string[];
  /** What the caller should do instead. */
  remedy: string[];
}

/**
 * May this writer append a governed event to this project?
 *
 * The one question Studio never asked. It is answered before a byte is
 * written, and it is answered from capabilities on both sides rather than from
 * a comparison of version strings.
 */
function writerMayWrite(requirements: ProjectRequirements, writer: WriterCapabilities): CompatibilityVerdict {
  const reasons: string[] = [];
  const remedy: string[] = [];

  if (writer.schema_version !== requirements.schema_version) {
    reasons.push(
      `the project is schema ${requirements.schema_version} and this writer speaks schema ${writer.schema_version}.`
    );
  }
  if (writer.writes_event_format < requirements.minimum_writer_event_format) {
    reasons.push(
      `the project's history is at event format ${requirements.minimum_writer_event_format} and this writer produces format ${writer.writes_event_format}. ` +
      `An event in the older shape appended here breaks the digest chain at that line, and every event after it becomes unverifiable.`
    );
    remedy.push(`Use a writer that produces event format ${requirements.minimum_writer_event_format} or later.`);
  }
  if (!requirements.event_formats_present.every((format) => writer.reads_event_formats.includes(format))) {
    const unreadable = requirements.event_formats_present.filter((format) => !writer.reads_event_formats.includes(format));
    reasons.push(`the history contains event format ${unreadable.join(", ")}, which this writer cannot read.`);
  }
  if (requirements.malformed_events > 0) {
    reasons.push(
      `${requirements.malformed_events} event${requirements.malformed_events === 1 ? "" : "s"} in this history declare${requirements.malformed_events === 1 ? "s" : ""} a format whose required fields ${requirements.malformed_events === 1 ? "it does" : "they do"} not carry. ` +
      `Writing on top of that would add a verifiable event to an unverifiable history.`
    );
    remedy.push(`plangonaut replay --verify --project-root . says which, and plangonaut baseline is how a history is made verifiable again from a declared point.`);
  }

  return { compatible: reasons.length === 0, reasons, remedy };
}

/**
 * `compat-check` — may this writer write here, and if not, why?
 *
 * A command rather than a library call, because the caller that needs it most
 * is a different process in a different language, and a process boundary is the
 * only place the answer cannot drift from the engine that enforces it.
 */
function compatCheck(flags: Flags): void {
  const root = resolveProject(required(flags, "project-root"));
  const requirements = projectRequirements(root);
  const writer = writerCapabilities();

  /*
   * A caller may ask on behalf of another writer.
   *
   * Studio asks "may *I* write here", and it is not this engine. It passes what
   * it can do and gets an answer about itself rather than about the CLI that
   * happens to be answering.
   */
  const asked: WriterCapabilities = {
    ...writer,
    ...(flags["writer-engine"] ? { engine: String(flags["writer-engine"]) } : {}),
    ...(flags["writer-version"] ? { version: String(flags["writer-version"]) } : {}),
    ...(flags["writer-schema"] ? { schema_version: Number(flags["writer-schema"]) } : {}),
    ...(flags["writer-event-format"] ? { writes_event_format: Number(flags["writer-event-format"]) } : {}),
    ...(flags["writer-reads-formats"]
      ? { reads_event_formats: String(flags["writer-reads-formats"]).split(",").map((item) => Number(item.trim())).filter((item) => Number.isFinite(item)) }
      : {}),
  };

  const verdict = writerMayWrite(requirements, asked);

  if (flags.json === true) {
    console.log(JSON.stringify({ project: requirements, writer: asked, verdict }, null, 2));
    if (!verdict.compatible) reportedExitCode = 2;
    return;
  }

  console.log(`Project: schema ${requirements.schema_version}, event format ${requirements.event_format}` +
    `${requirements.event_formats_present.length > 1 ? ` (history contains ${requirements.event_formats_present.join(", ")})` : ""}` +
    `${requirements.last_engine_version ? `, last written by ${requirements.last_engine_version}` : ", last writing engine not recorded"}.`);
  console.log(`Writer:  ${asked.engine} ${asked.version}, schema ${asked.schema_version}, writes event format ${asked.writes_event_format}, reads ${asked.reads_event_formats.join(", ")}.`);
  console.log("");
  if (verdict.compatible) {
    console.log(`Compatible: this writer may append governed events to this project.`);
    return;
  }
  console.log(`Incompatible. Governed writing is refused:`);
  for (const reason of verdict.reasons) console.log(`- ${reason}`);
  if (verdict.remedy.length) {
    console.log(`\n${verdict.remedy.join("\n")}`);
  }
  console.log(`\nReading is unaffected. Nothing was written.`);
  reportedExitCode = 2;
}

function status(flags: Flags): void {
  const root = resolveProject(required(flags, "project-root"));
  const state = validateRoot(root);
  /*
   * A project whose state does not match its history has no status worth
   * printing.
   *
   * `validate`, `resume` and `replay --verify` all exit 2 on such a project;
   * `status` printed the state's own account of itself as fact and exited 0. A
   * third independent review noticed it beside the areas it had been asked
   * about. It is the same defect as the two before it, in the one remaining
   * command that answers the question "how is this project?".
   */
  const history = historyErrors(root, state);
  if (history.errors.length) {
    throw new PlangonautError(
      `This project's state does not agree with its history, so its status cannot be reported as fact:\n- ${history.errors.join("\n- ")}\n` +
        `Rebuild it from the history with \`plangonaut replay --project-root . --repair --operation-id <id>\`, or restore the state. Nothing was changed.`,
      "PROJECT_STATE_UNTRUSTED",
    );
  }
  const active = activeModule(state);
  /*
   * Which format this project is stored in, declared rather than implied.
   *
   * A caller that reads a legacy project and is not told so will eventually
   * write a path, a message or a document that assumes the other directory. It
   * is two fields: the format, and the directory name, because a human reading
   * the machine output should not have to know the mapping.
   */
  const where = locateState(root);
  console.log(JSON.stringify({ project: state.project.name, versions: versionProvenance(state), state_format: where.format, state_directory: where.name, project_mode: state.project.mode, interaction_mode: state.interaction_mode, question_block_size: questionBlockSize(state), lifecycle_state: state.lifecycle_state, current_gate: state.current_gate, coverage: `${state.modules.filter((item) => new Set(["CONFIRMED", "DEFERRED", "NOT APPLICABLE"]).has(item.status)).length}/${state.modules.length}`, active_module: active && { id: active.id, title: active.title, status: active.status }, needs_reconciliation: state.needs_reconciliation, open_overrides: state.human_overrides.filter((item) => item.status === "OPEN").length, ...blockerAssurance(state), module_progress: moduleProgressJson(state), progress_forecast: statusForecast(state), standing_notices: noticeSummary(root), advance_blocked_by: advanceHold(root, state), readiness: statusReadiness(root, state), exact_next_action: state.exact_next_action, updated_at: state.updated_at }, null, 2));
}

/**
 * The compact forecast `status` carries.
 *
 * Always an object, and always carrying `recorded`. `null` would have been shorter
 * and would have made "never recorded" indistinguishable from "a field a reader
 * forgot to check": a machine consumer that renders a missing forecast as an empty
 * range or a zero is precisely the failure D5 names.
 */
/**
 * The three states, for a machine reader.
 *
 * `status` never re-derives anything from the ledger except this, and this is
 * derived rather than stored on purpose: a readiness written into the state
 * would be a claim that ages, and the whole defect this closes is a project
 * carrying a claim about itself that nothing had rechecked.
 */
function statusReadiness(root: string, state: State): Record<string, unknown> {
  const report = readinessReport(state, root);
  const reads = readStandings(root, state);
  return {
    execution_intent: report.intent === "UNDECLARED" ? "NOT DECLARED" : report.intent === "NO" ? "DEFINITION_ONLY" : "EXECUTION",
    definition: report.definition.verdict,
    definition_findings: report.definition.findings,
    execution: report.execution.verdict,
    execution_findings: report.execution.findings,
    reads: {
      proved: reads.filter((entry) => entry.standing === "PROVED").length,
      changed_since: reads.filter((entry) => entry.standing === "CHANGED SINCE").length,
      missing: reads.filter((entry) => entry.standing === "MISSING").length,
      recorded: reads.length,
    },
  };
}

function statusForecast(state: State): Record<string, unknown> {
  const entry = state.progress_forecast;
  if (!entry) return { recorded: false, note: FORECAST_NEVER_RECORDED, record_with: FORECAST_RECORD_COMMAND };
  return {
    recorded: true,
    phase: entry.phase,
    questions: entry.questions,
    operations: entry.operations,
    cycles: entry.cycles,
    confidence: entry.confidence,
    cycle_state: entry.cycle_state,
    // Derived from the stored signals only; `status` re-derives nothing from the
    // ledger, so what it shows is what was recorded.
    derived_cycle_state: impliedCycleState(entry.signals ?? []),
    signals: (entry.signals ?? []).map((signal) => signal.code),
    recorded_by: entry.recorded_by,
    recorded_at: entry.recorded_at,
    state_revision: entry.state_revision,
    history_entries: (state.forecast_history ?? []).length,
  };
}

// ---------------------------------------------------------------------------
// Where the interview has been, and where it has not
// ---------------------------------------------------------------------------

/**
 * Which modules have to be underway before another module's answers can be
 * trusted.
 *
 * This is a claim about the subject matter, so it is written down rather than
 * inferred, and it is deliberately short: only the dependencies strong enough
 * that answering downstream first produces work that may have to be thrown away.
 *
 * The pilot is the worked example. A complete architecture for a registry and a
 * detection system was designed — schema, per-function detail, the lot — while
 * module 10, *technology and development environment*, had never been opened. The
 * language the thing would be written in was undecided, and parts of that
 * architecture depend on it: how the credential store is addressed depends on how
 * the chosen language talks to DPAPI. Every command in that session answered OK.
 * Nothing anywhere related the depth reached to the ground it stood on.
 *
 * It does not block. It explains an ordering, and the ordering is reported
 * beside the question so the agent can overrule it deliberately instead of not
 * knowing about it.
 */
const MODULE_PREREQUISITES: Record<number, number[]> = {
  // Nothing is decidable before it is known what the project is and who it is for.
  3: [1],
  4: [1, 2],
  5: [2, 4],
  6: [10],
  7: [6, 10],
  8: [4],
  // Architecture rests on the type of project and the technology it is built with.
  9: [3, 10],
  11: [10],
  12: [3, 10],
  15: [4, 8],
  /*
   * And on the two operational modules.
   *
   * Their absence here is the mechanical cause of the pilot: module 16 is the
   * final review, its prerequisites were the modules that define the project,
   * and the two that organise its execution were not among them. An interview
   * could therefore arrive at "does the blueprint reflect your intent?" without
   * ever having asked who was going to build the thing.
   */
  16: [1, 2, 4, 9, 10, 14, 15],
};

/**
 * The declared threshold for "this interview is digging, not covering".
 *
 * Stated as three numbers rather than a feeling, because an agent has to be able
 * to predict when it will be told this, and a reader has to be able to disagree
 * with the rule rather than with the engine's mood. The pilot sits well past all
 * three: nine interactions, one module touched, fifteen never opened.
 */
const IMBALANCE_MIN_INTERACTIONS = 6;
const IMBALANCE_MAX_MODULES_TOUCHED = 3;
const IMBALANCE_MIN_UNTOUCHED = 10;

interface ModuleProgress {
  confirmed: number[];
  inProgress: number[];
  untouched: number[];
  /** `NOT STARTED` in the ledger, but carrying recorded interactions. */
  formallyOpen: number[];
  notApplicable: number[];
  deferred: number[];
  blocked: number[];
  /** Modules with at least one recorded interview interaction. */
  touched: number[];
  interactions: Map<number, number>;
  questions: { planned: number; asked: number; answered: number; settled: number; closed: number };
  imbalance: { interactions: number; touched: number[]; untouched: number[] } | null;
}

function moduleProgress(state: State): ModuleProgress {
  const buckets: ModuleProgress = {
    confirmed: [], inProgress: [], untouched: [], formallyOpen: [], notApplicable: [], deferred: [], blocked: [],
    touched: [], interactions: new Map(),
    questions: { planned: 0, asked: 0, answered: 0, settled: 0, closed: 0 },
    imbalance: null,
  };
  for (const module of state.modules ?? []) {
    if (module.status === "CONFIRMED") buckets.confirmed.push(module.id);
    else if (module.status === "NOT APPLICABLE") buckets.notApplicable.push(module.id);
    else if (module.status === "DEFERRED") buckets.deferred.push(module.id);
    else if (module.status === "BLOCKED") buckets.blocked.push(module.id);
    else if (module.status === "NOT STARTED") buckets.untouched.push(module.id);
    else buckets.inProgress.push(module.id);
  }
  for (const entry of interviewLog(state)) {
    if (entry.status === "SUPERSEDED") continue;
    if (typeof entry.module === "number") {
      buckets.interactions.set(entry.module, (buckets.interactions.get(entry.module) ?? 0) + 1);
    }
    if (entry.status === "PLANNED") buckets.questions.planned += 1;
    else if (entry.status === "ASKED") buckets.questions.asked += 1;
    else if (entry.status === "ANSWERED") {
      // There is no SETTLED status: settled is ANSWERED with the consequences
      // recorded. Counting them as one number hid the difference the ledger
      // exists to keep — an answer received is not an answer applied.
      if (nonEmpty(entry.consequences_recorded_at)) buckets.questions.settled += 1;
      else buckets.questions.answered += 1;
    } else buckets.questions.closed += 1;
  }
  buckets.touched = [...buckets.interactions.keys()].sort((a, b) => a - b);

  /*
   * A module can be `NOT STARTED` in the ledger and worked on in fact.
   *
   * On a project written by an engine that did not move module status — which is
   * every project written before `0.3.0-alpha.5` — nine recorded questions sit
   * under a module that still reads `NOT STARTED`. Counting it as never opened
   * produced two sentences that contradicted each other in the same paragraph:
   * *"9 interactions, all on module 1"* and *"module 1 has never been opened"*.
   * Found by running this against the real pilot.
   *
   * So "never opened" means the ledger says `NOT STARTED` **and** nothing was
   * ever recorded against it. The rest are formally incomplete rather than
   * untouched, which is a different thing and is reported as one.
   */
  buckets.formallyOpen = buckets.untouched.filter((id) => buckets.interactions.has(id));
  buckets.untouched = buckets.untouched.filter((id) => !buckets.interactions.has(id));

  const total = [...buckets.interactions.values()].reduce((sum, count) => sum + count, 0);
  if (
    total >= IMBALANCE_MIN_INTERACTIONS &&
    buckets.touched.length <= IMBALANCE_MAX_MODULES_TOUCHED &&
    buckets.untouched.length >= IMBALANCE_MIN_UNTOUCHED
  ) {
    buckets.imbalance = { interactions: total, touched: buckets.touched, untouched: buckets.untouched };
  }
  return buckets;
}

/**
 * The same counts, for a consumer that cannot read a sentence.
 *
 * `coverage: "1/17"` stays where it is and means what it always meant — modules
 * in a terminal status over all modules — but it is no longer the only thing a
 * reader has. A fraction that counts confirmations says "almost nothing done"
 * about a project that has done a great deal and confirmed none of it, which is
 * the difference this object exists to carry.
 */
function moduleProgressJson(state: State): Record<string, unknown> {
  const progress = moduleProgress(state);
  return {
    confirmed: progress.confirmed,
    in_progress: progress.inProgress,
    never_opened: progress.untouched,
    formally_not_started_but_worked_on: progress.formallyOpen,
    not_applicable: progress.notApplicable,
    deferred: progress.deferred,
    blocked: progress.blocked,
    interactions_by_module: Object.fromEntries([...progress.interactions].sort((a, b) => a[0] - b[0])),
    // Not `questions`: `status` already refuses to expose a `questions` object
    // for a forecast nobody recorded, and these counts are interview entries by
    // state, not a forecast range. Two different things must not share a name in
    // the same document.
    interview_questions: progress.questions,
    coverage_imbalance: progress.imbalance
      ? { ...progress.imbalance, threshold: { min_interactions: IMBALANCE_MIN_INTERACTIONS, max_modules_touched: IMBALANCE_MAX_MODULES_TOUCHED, min_untouched: IMBALANCE_MIN_UNTOUCHED } }
      : null,
  };
}

/** The imbalance, in words, with the choice left to whoever reads it. */
function imbalanceLines(progress: ModuleProgress): string[] {
  if (!progress.imbalance) return [];
  const { interactions, touched, untouched } = progress.imbalance;
  return [
    `COVERAGE: ${interactions} recorded interaction${interactions === 1 ? "" : "s"}, all on module${touched.length === 1 ? "" : "s"} ${touched.join(", ")}, while ${untouched.length} module${untouched.length === 1 ? " has" : "s have"} never been opened: ${untouched.join(", ")}.`,
    `Depth is not progress across the project. Going deeper here may be the right call — say so and record it — but it is a choice, and until it is made the blueprint rests on modules nobody has looked at.`,
  ];
}

/** Prerequisite modules that are still untouched, for a module being worked on. */
function missingPrerequisites(state: State, moduleId: number): number[] {
  const required = MODULE_PREREQUISITES[moduleId] ?? [];
  return required.filter((id) => {
    const module = (state.modules ?? []).find((item) => item.id === id);
    return !module || module.status === "NOT STARTED";
  });
}

function nextQuestions(state: State, requestedCount?: string | boolean): string {
  const active = activeModule(state);
  if (!active) return "Questionnaire coverage complete. Next: approve the research/synthesis gate.\n";
  /*
   * A block, not a quota.
   *
   * This used to hand back one, two or three questions depending on the
   * interaction mode, and refuse anything else -- which read as though the mode
   * decided how much interviewing a project was allowed. It does not. The mode
   * is about depth and tone; the number of questions an interview needs comes
   * from the gaps in it, and there are as many blocks as it takes.
   *
   * Five is the default block because it is what a person can hold in view and
   * answer in one sitting. `--count` moves it, and the skill asks the user what
   * they want and honours the answer.
   */
  const count = requestedCount ? parseBlockSize(requestedCount, "--count") : questionBlockSize(state).effective;
  const catalog = questionnaire().find((item: any) => item.id === active.id);
  /*
   * A catalog question the ledger already answers is marked, not printed clean.
   *
   * `next` had no idea the interview ledger existed, so it reprinted, word for
   * word, a question recorded as ANSWERED and applied. Matching is on the exact
   * text: crude, and it is the only comparison that cannot claim more than it
   * knows. A paraphrase is not detected, and nothing here pretends otherwise --
   * which is why these are marked rather than removed.
   */
  const answered = new Map<string, string>();
  for (const item of interviewLog(state)) {
    // Any recorded answer counts, settled or not, and a question closed as
    // deferred or skipped counts too: all of them are decisions the history
    // already holds, and re-proposing one asks the user to repeat themselves.
    // This used to test `status === "ANSWERED"` alone, so an answer that had been
    // applied — the normal end state — stopped matching the moment it was
    // settled, and the question came back.
    if (nonEmpty(item.answer) || QA_CLOSE_KINDS.has(String(item.status).toLowerCase())) {
      answered.set(item.question.trim(), `${item.id} (${item.status.toLowerCase()})`);
    }
  }
  const lines = catalog!.questions.slice(0, count).map((question: string, index: number) => {
    const recorded = answered.get(question.trim());
    return recorded
      ? `${index + 1}. ${question}${NL}   Already in the history as ${recorded}. Do not ask it again unless that answer was invalidated.`
      : `${index + 1}. ${question}`;
  });
  const missing = missingPrerequisites(state, active.id);
  const prerequisite = missing.length
    ? [
        `Before these: module${missing.length === 1 ? "" : "s"} ${missing.join(", ")} ${missing.length === 1 ? "has" : "have"} never been opened, and ${missing.length === 1 ? "it is" : "they are"} what module ${active.id} rests on.`,
        `Answering here first is allowed and may be right; it means accepting that a later answer there can invalidate what is decided now.`,
      ]
    : [];
  return [
    `Module ${active.id} — ${active.title} [${active.status}]`,
    ...prerequisite,
    ...lines,
    "Stop after the user's answers; confirm them before recording the module outcome.",
    "",
  ].join("\n");
}

/**
 * What to do next, read from the ledger before the catalogue.
 *
 * `next` is the command made for saying where to go, and in the pilot it was the
 * command that could not. It looked only at `modules[].status`; nothing writes
 * that but `record --module`; nobody ran `record --module`; so after nine
 * answered questions it kept offering module 1's first two catalogue questions,
 * one of which the history already answered. The one command that could have
 * corrected the interview's direction would not have corrected it if it had been
 * run.
 *
 * The order is now: what is already open here, then what this module rests on,
 * then the catalogue. Something in flight outranks something new, because an
 * unfinished interaction is the most specific instruction the project holds —
 * and a `PLANNED` question, written ahead by `qa-settle --next-id`, is exactly
 * that: the last person to think about this project already decided what comes
 * next, and proposing a catalogue question instead throws that decision away.
 *
 * It also reports the shape of the work rather than one fraction. `1/17` said
 * "almost nothing done" about a session that had overturned the project's
 * founding principle, because the fraction counts only confirmations and nothing
 * had been confirmed.
 */
/*
 * Recording the block size, and why it takes a flag of its own.
 *
 * `--count 3` is somebody asking for three questions this once. Letting that
 * silently become the project's standing preference is how a folder ends up
 * asserting a choice nobody made -- the defect this whole cycle is about, in
 * miniature. So an occasional count changes nothing, and `--remember` is the
 * sentence "this is how we work from now on", with an owner and an operation id
 * like every other thing a person decides here.
 *
 * It is the shape the engine already has for a command that reads until told
 * otherwise: `replay --repair`, `recover --apply`. No new command, no settings
 * file, and `plangonaut next` on its own still writes nothing.
 */
function rememberQuestionBlockSize(root: string, flags: Flags): void {
  if (!nonEmpty(flags.count)) {
    throw new PlangonautError(
      `--remember needs the size to remember: pass --count N as well. Nothing was written.`
    );
  }
  const size = parseBlockSize(flags.count, "--count");
  const key = idempotencyKey(flags);
  if (checkIdempotency(root, key)) return console.log("Idempotent retry: the question block size is already recorded.");
  const { location, state } = loadState(root);
  const owner = required(flags, "owner").trim();
  assertKnownOwner(state, owner);

  const before = questionBlockSize(state);
  const timestamp = now();
  (state as any).question_block_size = size;
  state.updated_at = timestamp;
  const revision = state.revision + 1;
  const eventId = crypto.randomUUID();
  state.revision = revision;
  state.last_event_id = eventId;
  commitState(root, location, state, {
    event_id: eventId,
    type: "QUESTION_BLOCK_SIZE_SET",
    state_revision: revision,
    at: timestamp,
    idempotency_key: key,
    owner,
    question_block_size: size,
    // What it was, including "nothing was recorded", so the history says whether
    // this was a first choice or a change of mind.
    previous_question_block_size: before.recorded ? before.effective : null,
  });
  console.log(
    `Recorded: the interview puts ${size} question${size === 1 ? "" : "s"} in a block, at revision ${revision}.\n` +
    `This is how many are laid out at once. It does not limit how many blocks the interview has.`
  );
}

/**
 * What the project needs operationally, phrased as the thing to do next.
 *
 * Returns nothing when there is nothing to say — a definition-only project, or
 * one whose execution readiness already passes — because a command that always
 * prints a warning has stopped being a warning.
 */
function operationalRedirect(state: State, readiness: ReadinessReport): string[] {
  if (readiness.intent === "NO") return [];

  const definitionSettled = readiness.definition.verdict === "PASSED";
  const lines: string[] = [];

  if (readiness.intent === "UNDECLARED") {
    if (!definitionSettled) return [];
    lines.push(
      `BEFORE THE FINAL REVIEW: nobody has declared whether this project is meant to be built.`,
      `  The definition looks substantially complete, and what happens next depends entirely on the answer.`,
      `  If it is a study, a proposal, a concept note, a tender or a feasibility analysis, say so and the definition is the deliverable:`,
      `    plangonaut execution-intent --project-root . --definition-only --reason "<why>" --owner <owner> --operation-id <id>`,
      `  If it is to be built:`,
      `    plangonaut execution-intent --project-root . --execution --reason "<why>" --owner <owner> --operation-id <id>`,
      `  The engine does not infer this from the absence of tasks, because an unfinished project looks the same.`,
    );
    return lines;
  }

  if (readiness.execution.verdict !== "FAILED") return [];

  lines.push(
    `BEFORE THE FINAL REVIEW: this project is to be built, and ${readiness.execution.findings.length} thing${readiness.execution.findings.length === 1 ? "" : "s"} stop${readiness.execution.findings.length === 1 ? "s" : ""} anybody from starting.`,
  );
  for (const finding of readiness.execution.findings.slice(0, 5)) lines.push(`  - ${finding}`);
  if (readiness.execution.findings.length > 5) lines.push(`  - … and ${readiness.execution.findings.length - 5} more: plangonaut execution-readiness --project-root .`);
  lines.push(
    ``,
    `  These are answered by the operational interview, not by more definition and not by writing code.`,
    `  Modules 14 and 15 are where they belong: who executes this, with what authority, in what order, and how anyone knows a piece is done.`,
    `  The organisation is proposed, not invented by the user: complete the decomposition, work out what is genuinely independent,`,
    `  put a motivated configuration with its costs and alternatives, and record what is approved with plangonaut execution-org.`,
  );
  return lines;
}

function next(flags: Flags): void {
  const root = resolveProject(required(flags, "project-root"));
  if (flags.remember === true) return rememberQuestionBlockSize(root, flags);
  const state = validateRoot(root);
  if (state.needs_reconciliation) {
    const open = state.human_overrides.find((item) => item.status === "OPEN");
    console.log(`BLOCKED: reconcile ${open?.id} before asking further questionnaire questions.`);
    return;
  }

  const progress = moduleProgress(state);
  const open = openInterviewEntries(state);
  const lines: string[] = [];

  // Before any question, what the project already contradicts about itself.
  const hold = advanceHoldLines(advanceHold(root, state));
  if (hold.length) lines.push(...hold, "");

  // 1. An answer received and not applied. Nothing else may start first: that is
  //    already `qa-ask`'s refusal, and `next` should not propose what qa-ask
  //    would refuse.
  if (open.unapplied.length) {
    const entry = open.unapplied[0];
    lines.push(`FIRST: ${entry.id} has an answer that has not been applied.`);
    lines.push(`  ${entry.question}`);
    lines.push(`Why this before anything else: the ledger records what was asked and what came back, and nothing yet records what it changed. qa-ask refuses a new question while this is open.`);
    lines.push(`  plangonaut qa-settle --project-root . --id ${entry.id} --interpretation "..." --reply-file <file> --owner <owner> --operation-id <id>`);
  }
  // 2. A question already put and waiting.
  else if (open.asked.length) {
    const entry = open.asked[0];
    lines.push(`FIRST: ${entry.id} has been asked and is waiting for an answer.`);
    lines.push(`  ${entry.question}`);
    lines.push(`Why this before a new one: it is already in flight, and a second open question makes it ambiguous which one the next answer belongs to.`);
    lines.push(`  plangonaut qa-answer --project-root . --id ${entry.id} --answer-file <file> --owner <owner> --operation-id <id>`);
  }
  // 3. A question somebody already decided should come next.
  else if (open.planned.length) {
    const entry = open.planned[0];
    lines.push(`FIRST: ${entry.id} is PLANNED — it was written ahead of time as the next question and has not been put yet.`);
    lines.push(`  ${entry.question}`);
    if (nonEmpty(entry.rationale)) lines.push(`  Why it was planned: ${entry.rationale}`);
    lines.push(`Why this before the catalogue: the catalogue does not know what this project just learned. Somebody did, and wrote it down.`);
    lines.push(`Ask it, then: plangonaut qa-answer --project-root . --id ${entry.id} --answer-file <file> --owner <owner> --operation-id <id>`);
  }
  // 4. Nothing open: the catalogue, for the module that is actually next.
  else {
    lines.push(nextQuestions(state, flags.count).trimEnd());
  }

  /*
   * Before the catalogue's next question: the operational gap, when there is one.
   *
   * The pilot's `next` was not wrong about the module it proposed. It was
   * answering "what is the next interview question" while the project's actual
   * next thing was "nobody has decided how any of this gets built", and no
   * command was asking that question at all.
   *
   * This does not replace the question above it. It goes in front of it, named
   * as what it is, because a reader who is about to be offered the final review
   * needs to know that the review would be approving a blueprint with no plan
   * under it.
   */
  const readiness = readinessReport(state, root);
  const operational = operationalRedirect(state, readiness);
  if (operational.length) lines.unshift(...operational, "");

  const imbalance = imbalanceLines(progress);
  if (imbalance.length) {
    lines.push("", ...imbalance);
    /*
     * Saying the interview is unbalanced and then proposing the same module
     * again is advice nobody can act on.
     *
     * Found by running three simulated rounds against this command: it reported
     * nine interactions on one module and fifteen never opened, and then offered
     * that module's opening two catalogue questions for the third time. Both
     * halves were individually correct and together they told the reader to
     * widen while handing them the narrow thing.
     *
     * So the widening is named. The module offered is the first never-opened one
     * whose own prerequisites are not themselves unopened, because sending
     * somebody to a module that rests on another unopened module moves the
     * problem rather than solving it.
     */
    // Never propose widening to a module that already carries work: on a legacy
    // project the active module is `NOT STARTED` with nine questions under it,
    // and offering it as "the first module ready to be opened" is nonsense.
    const candidates = progress.untouched.filter((id) => !progress.interactions.has(id));
    const reachable = candidates.filter((id) => !missingPrerequisites(state, id).length);
    const widen = reachable[0] ?? candidates[0];
    if (widen !== undefined) {
      const module = (state.modules ?? []).find((item) => item.id === widen);
      lines.push(
        ``,
        `To widen instead, the first module that is ready to be opened is ${widen}${module ? ` — ${module.title}` : ""}${reachable.length ? "" : " (its own prerequisites are open too; nothing here is free of them)"}.`,
        `A question recorded there while the interview is on module ${activeModule(state)?.id ?? "the current one"} needs --crosscutting --crosscutting-reason "<why>", which is how the ledger keeps a deliberate widening distinguishable from losing track of where you were.`,
      );
    }
  }

  // The shape of the work, never the single fraction.
  const summary = [
    ``,
    `Modules: ${progress.confirmed.length} confirmed, ${progress.inProgress.length} in progress, ${progress.untouched.length} never opened, ${progress.notApplicable.length} not applicable${progress.deferred.length ? `, ${progress.deferred.length} deferred` : ""}${progress.blocked.length ? `, ${progress.blocked.length} blocked` : ""}.`,
    ...(progress.formallyOpen.length
      ? [`Module${progress.formallyOpen.length === 1 ? "" : "s"} ${progress.formallyOpen.join(", ")} read NOT STARTED and carry recorded work: written by an engine that did not move module status. Formally incomplete, not untouched.`]
      : []),
    `Questions: ${progress.questions.planned} planned, ${progress.questions.asked} asked, ${progress.questions.answered} answered and not applied, ${progress.questions.settled} settled, ${progress.questions.closed} closed without an answer.`,
    `Ledger: ${state.requirements.length} requirements, ${state.decisions.length} decisions, ${state.risks.length} risks, ${state.tasks.length} tasks, ${openBlockers(state).length} open blockers, ${state.evidence.length} evidence records.`,
    `Phase ${state.lifecycle_state}, gate ${state.current_gate}.`,
  ];
  const forecast = state.progress_forecast;
  if (forecast) {
    summary.push(
      `Forecast: ${forecastRangeText(forecast.questions)} questions, ${forecastRangeText(forecast.cycles)} cycles, confidence ${forecast.confidence}, cycle state ${forecast.cycle_state} (recorded ${forecast.recorded_at}).`
    );
  } else {
    summary.push(`Forecast: none recorded. plangonaut forecast is how a project says how much it thinks is left.`);
  }
  lines.push(...summary);
  console.log(lines.join("\n"));
}

// ---------------------------------------------------------------------------
// The interview ledger
// ---------------------------------------------------------------------------

/**
 * One recorded interaction.
 *
 * Everything here is either supplied by the caller or computed from state at the
 * moment of recording. Nothing is inferred later: an entry says what was asked,
 * what came back, and what was done about it, and a field nobody filled reads as
 * `null` rather than as a plausible default.
 */
interface InterviewEntry {
  id: string;
  status: string;
  module: number | null;
  /**
   * The question belongs to a module other than the one the interview is on.
   *
   * Recorded rather than inferred, with the reason beside it, because the two
   * ALN-011 pilots both ended with questions on module 2 while the active module
   * was 1 and nothing in either folder said why.
   */
  crosscutting?: boolean;
  crosscutting_reason?: string | null;
  lifecycle_state: string;
  gate: string;
  agent: string | null;
  /** Who recorded the answer, when that is not who asked. Never overwrites it. */
  answered_by_agent?: string | null;
  owner: string;
  question: string;
  rationale: string;
  asked_at: string | null;
  answer: string | null;
  answered_at: string | null;
  interpretation: string | null;
  reply: string | null;
  consequences: string[];
  documents: string[];
  open_points: string[];
  /** Set only by `qa-settle`, and only after the consequences are recorded. */
  consequences_recorded_at: string | null;
  next_id: string | null;
  next_question: string | null;
  supersedes: string | null;
  superseded_by: string | null;
  closed_reason: string | null;
  /** True only for an entry rebuilt from durable evidence, never from a guess. */
  reconstructed: boolean;
  /** The file that evidence is in. Required whenever `reconstructed` is true. */
  reconstructed_from?: string | null;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// A module that has been worked on
// ---------------------------------------------------------------------------

/**
 * The status this engine uses for "started, not finished".
 *
 * The pilot's report asks for `IN PROGRESS`, and the schema does not have it.
 * `MODULE_STATUSES` is `NOT STARTED`, `IN DISCUSSION`, `CONFIRMED`, `PARTIAL`,
 * `DEFERRED`, `NOT APPLICABLE`, `BLOCKED`, and writing a value outside that list
 * would be refused by `stateErrors` on the same operation that wrote it — and,
 * worse, would mean Studio's copy of the vocabulary and the schema disagree with
 * the ledger. The word the schema already has for a module under discussion is
 * `IN DISCUSSION`, and that is what the interview produces: discussion.
 */
const MODULE_IN_PROGRESS = "IN DISCUSSION";

/**
 * Mark a module as started, because something was recorded against it.
 *
 * `coverage: 1/17` was the pilot's most misleading number. Nine questions and
 * answers were recorded against module 1, all of them visible in
 * `QUESTION_ANSWER_HISTORY.md` under `Module: 1`, and module 1 said
 * `NOT STARTED` — because the only command that has ever written
 * `modules[].status` is `record --module N --status …`, and nobody ran it. That
 * is not a conservative report, it is a false one, and it had a second effect:
 * `next` decides what to propose from the module ledger, so it stayed pinned to
 * module 1's catalogue questions and kept proposing questions already answered.
 *
 * What moves automatically is exactly one transition, `NOT STARTED` →
 * `IN DISCUSSION`, and only ever forward. `CONFIRMED` is a judgement about
 * whether the answers are good enough, `NOT APPLICABLE` is a judgement that the
 * module does not apply, `DEFERRED` and `BLOCKED` are decisions — no automatism
 * writes any of them, and none of them is overwritten by activity arriving
 * afterwards. The engine may record that work happened; it may not record what
 * the work means.
 */
function touchModule(state: State, moduleId: unknown, at: string): number | null {
  if (typeof moduleId !== "number" || !Number.isInteger(moduleId)) return null;
  const module = (state.modules ?? []).find((item) => item.id === moduleId);
  if (!module || module.status !== "NOT STARTED") return null;
  module.status = MODULE_IN_PROGRESS;
  module.updated_at = at;
  // `owner` and `evidence` stay as they are. An interview interaction is not an
  // owner's sign-off and it is not an evidence file; filling either from an
  // automatism would put an assertion in the ledger that nobody made.
  return moduleId;
}

/** What to say when activity has just opened a module that said NOT STARTED. */
function moduleStartedLine(moduleId: number, state: State): string {
  const module = (state.modules ?? []).find((item) => item.id === moduleId);
  return (
    `Module ${moduleId}${module ? ` — ${module.title}` : ""} moved from NOT STARTED to ${MODULE_IN_PROGRESS}, because work was recorded against it. ` +
    `Confirming it stays a decision: plangonaut record --module ${moduleId} --status CONFIRMED.`
  );
}

// ---------------------------------------------------------------------------
// Where a decision came from
// ---------------------------------------------------------------------------

/**
 * The provenance an `APPROVED` decision has to have, or it is not approved.
 *
 * The pilot produced a folder whose documents read as settled and whose decision
 * ledger was empty, and the reverse is just as available: a decision can be
 * written `APPROVED` by an agent that read some code, inferred what it implied,
 * and recorded the inference as a choice. Nothing checked that a person had ever
 * said so.
 *
 * Reading a folder authorises an agent to record **facts**. It does not
 * authorise it to turn existing code, a prototype, a comment or a previous
 * behaviour into a future commitment. Scope, priorities, requirements, risk
 * acceptance and preferences are the user's, and an `APPROVED` decision claims
 * exactly that kind of assent.
 *
 * So approval needs a trail that can be re-read:
 *
 *  - **interview** — a question was put, the user answered it in their own
 *    words, the answer was applied, and the settlement named this decision as a
 *    consequence. All four facts are already in the ledger, so nothing new has
 *    to be asserted: `consequences` is validated against the record ids, and
 *    `consequences_recorded_at` is written only by the command that applies an
 *    answer.
 *  - **override** — a person gave a direct instruction, its text is in the
 *    project, and its digest is recorded.
 *
 * Nothing else counts. An agent's own reasoning, however good, is a
 * **proposal**, and a proposal's status is `PROPOSED`.
 */
interface DecisionProvenance {
  kind: "interview" | "override" | "statement";
  ref: string;
  authority: string;
  at: string;
  /** Present for a statement: the digest of the file the approval points at. */
  sha256?: string;
}

function findDecisionProvenance(state: State, decisionId: string): DecisionProvenance | null {
  for (const entry of interviewLog(state)) {
    if (!nonEmpty(entry.consequences_recorded_at)) continue;
    if (!nonEmpty(entry.answer)) continue;
    if (entry.status === "SUPERSEDED") continue;
    if (!(entry.consequences ?? []).includes(decisionId)) continue;
    return {
      kind: "interview",
      ref: entry.id,
      authority: entry.owner,
      at: String(entry.consequences_recorded_at),
    };
  }
  return null;
}

/** An override, as provenance: a person's instruction, recorded with its digest. */
function overrideProvenance(state: State, overrideId: string): DecisionProvenance | null {
  const item = (state.human_overrides ?? []).find((entry) => entry.id === overrideId);
  if (!item) return null;
  return {
    kind: "override",
    ref: item.id,
    authority: item.owner,
    at: String((item as any).created_at ?? ""),
  };
}

/**
 * Decisions that say `APPROVED` and cannot show who approved them.
 *
 * Reported, never refused, and that asymmetry is the compatibility rule. A
 * project written before this release has decisions whose provenance was never
 * recorded; refusing them would break every existing folder to enforce a rule
 * that did not exist when they were written. The write path refuses a *new*
 * unprovenanced approval; this reports the ones already there, so the gap is
 * visible and can be closed deliberately.
 */
function unprovenancedApprovals(state: State): string[] {
  const found: string[] = [];
  for (const decision of state.decisions ?? []) {
    if (String(decision.status).toUpperCase() !== "APPROVED") continue;
    if ((decision as any).provenance) continue;
    if (findDecisionProvenance(state, decision.id)) continue;
    found.push(
      `decision ${decision.id} is APPROVED and records no provenance: no settled question names it as a consequence, and no override is cited. ` +
      `It may be right, and nothing here can tell. Link it by settling the question it came from with --consequences ${decision.id}, ` +
      `or re-record it with plangonaut decision --status APPROVED --provenance-override <OVR-ID>.`
    );
  }
  return found;
}

/**
 * What has to be true before a module may be called `CONFIRMED`.
 *
 * `CONFIRMED` is the strongest thing the ledger says about a module: it means
 * the concerns in it are settled and the project may build on them. The pilot
 * showed how cheaply it could be reached — one command with an evidence file,
 * where the evidence could be a summary the agent had just written about its own
 * reading. A document exists, therefore the module is confirmed. That is not a
 * confirmation, it is a restatement.
 *
 * So three things are checked, all of them already in the ledger and none of
 * them a matter of opinion:
 *
 *  - **no blocking question.** A question on that module that is planned, asked,
 *    or answered without its consequences applied is an open loop. Confirming
 *    over it buries it.
 *  - **the decisions it produced are approved.** A settled question on the
 *    module names its consequences; a decision among them still `PROPOSED` is a
 *    choice nobody has made.
 *  - **those approvals have provenance.** Otherwise the chain terminates in an
 *    agent's inference, which is where this whole class of defect starts.
 *
 * Evidence and owner were already required and still are. What is deliberately
 * *not* checked is whether the answers are any good: that is judgement, it
 * belongs to the person confirming, and a check that pretended to it would be
 * the same overreach in the opposite direction.
 */
// ---------------------------------------------------------------------------
// Three states of completeness, and why they are three
// ---------------------------------------------------------------------------

/*
 * A project can be thoroughly understood and impossible to execute.
 *
 * The pilot is the proof. Eighty-two decisions, thirty-three requirements,
 * sixteen modules of interview, and three tasks — all of them administrative.
 * Nothing in it was wrong. What was missing was the step where an agreed
 * outcome becomes work somebody can pick up: who does it, in what order, how
 * anyone knows a piece is finished. Every command reported that project as
 * healthy, because every command was measuring the first state and calling it
 * the whole.
 *
 * So there are three, and they are never merged:
 *
 *   definition        the problem, the users, the scope, the constraints, the
 *                     requirements, the decisions, the risks and the expected
 *                     result are settled.
 *   execution         that work has been turned into executable units with
 *                     responsibility, dependencies, acceptance and evidence.
 *   handoff           the folder carries everything a new executor needs to
 *                     start and finish without the original conversation.
 *
 * They are ordered but not equivalent: the first can be complete while the
 * second has not been started, which is exactly the pilot, and the third can
 * fail on a project whose first two are perfect because a document points at
 * somebody's desktop.
 */

type ReadinessVerdict = "PASSED" | "FAILED" | "NOT REQUESTED" | "NOT ASSESSED";

interface Readiness {
  verdict: ReadinessVerdict;
  /** What stops it, in the order found. Empty when it passes. */
  findings: string[];
  /** What would close the findings, for a reader who now has to act. */
  remedy: string[];
}

/** Statuses that mean a module has been dealt with one way or another. */
const MODULE_SETTLED = new Set(["CONFIRMED", "DEFERRED", "NOT APPLICABLE"]);

/**
 * Modules that define the project, as opposed to organising its execution.
 *
 * 14 and 15 are the operational pair and are deliberately outside this set:
 * a project can be completely defined without either, and saying so is the
 * point of separating the two states.
 */
const DEFINITION_MODULES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];

/** Work that builds the thing, as opposed to work that arranges for it. */
const IMPLEMENTATION_KINDS = new Set(["IMPLEMENTATION", "BUILD", "CONSTRUCTION", "DELIVERY", "RESOLUTION", "VERIFICATION"]);
const ADMINISTRATIVE_KINDS = new Set(["ADMINISTRATIVE", "ADMIN", "SETUP", "GOVERNANCE"]);

/**
 * Titles too general to be executable, recognised by shape rather than by list.
 *
 * A task called "build the app" is not a task, it is the project restated. What
 * makes it recognisable is not a vocabulary of forbidden words — that would
 * fire on honest titles in domains nobody anticipated — but the absence of
 * anything that narrows it: no component, no requirement, no acceptance
 * criterion, and a title short enough to be a heading.
 *
 * This is why the check is never a count. Three tasks can be a complete plan
 * for a small project and a hundred can be a hundred restatements of the same
 * intention; what decides it is whether each one says enough to be picked up.
 */
function taskIsUnderspecified(task: Task): string[] {
  const missing: string[] = [];
  if (!nonEmpty(task.acceptance)) missing.push("no acceptance criterion");
  if (!(task.requirements ?? []).length && !(task.decisions ?? []).length) missing.push("no requirement or decision of origin");
  if (!nonEmpty(task.role) && !nonEmpty(task.owner)) missing.push("no responsible role");
  if (!nonEmpty(task.verification) && !nonEmpty(task.evidence_expected)) missing.push("no verification or evidence");
  return missing;
}

/** Has this project said whether it is meant to be built? */
function executionRequested(state: State): "YES" | "NO" | "UNDECLARED" {
  const mode = String(state.execution_intent?.mode ?? "").toUpperCase();
  if (mode === "DEFINITION_ONLY") return "NO";
  if (mode === "EXECUTION") return "YES";
  return "UNDECLARED";
}

/**
 * Is the project understood?
 *
 * Deliberately generous, because this is the state the pilot genuinely reached
 * and calling it incomplete would be as wrong as calling the project finished.
 * It asks whether the defining modules are settled and whether the ledger holds
 * the things a definition produces.
 */
function definitionReadiness(state: State): Readiness {
  const findings: string[] = [];
  const modules = state.modules ?? [];
  const unsettled = DEFINITION_MODULES.filter((id) => {
    const module = modules.find((item: any) => item.id === id);
    return module !== undefined && !MODULE_SETTLED.has(String(module.status).toUpperCase());
  });
  if (unsettled.length) findings.push(`definition module${unsettled.length === 1 ? "" : "s"} ${unsettled.join(", ")} ${unsettled.length === 1 ? "is" : "are"} not settled.`);
  if (!(state.requirements ?? []).length) findings.push(`nothing states what the result has to do: no requirements are recorded.`);
  if (!(state.decisions ?? []).length) findings.push(`nothing states what was chosen: no decisions are recorded.`);
  const open = openInterviewEntries(state);
  if (open.unapplied.length) findings.push(`${open.unapplied[0].id} has an answer that was never applied.`);
  return {
    verdict: findings.length ? "FAILED" : "PASSED",
    findings,
    remedy: findings.length ? [`plangonaut next --project-root . proposes the question that closes the first of these.`] : [],
  };
}

/**
 * Is the work executable?
 *
 * Every finding below names something a person picking this folder up would
 * have to invent. None of them is about size: a one-person project fails this
 * only for the same reasons a twenty-person one does, and passing it does not
 * require agents, Git, or software.
 */
function executionReadiness(state: State): Readiness {
  const requested = executionRequested(state);
  if (requested === "NO") {
    return { verdict: "NOT REQUESTED", findings: [], remedy: [] };
  }
  if (requested === "UNDECLARED") {
    /*
     * Undeclared is not the same as definition-only, and never becomes it.
     *
     * Inferring the mode from the absence of tasks would reproduce the defect
     * exactly: the pilot has no implementation tasks, and the inference would
     * conclude that it was never meant to have any and declare it finished.
     */
    return {
      verdict: "NOT ASSESSED",
      findings: [`nobody has declared whether this project is meant to be built.`],
      remedy: [
        `If it is: plangonaut execution-intent --project-root . --execution --reason "<why>" --owner <owner> --operation-id <id>`,
        `If it is a study, a proposal, a concept note or a tender and no execution is intended:`,
        `  plangonaut execution-intent --project-root . --definition-only --reason "<why>" --owner <owner> --operation-id <id>`,
        `The engine does not guess this from the absence of tasks, because a project that is merely unfinished looks identical.`,
      ],
    };
  }

  const findings: string[] = [];
  const tasks = state.tasks ?? [];
  const requirements = state.requirements ?? [];

  // 1. Is there any work that builds the thing?
  const implementation = tasks.filter((task) => IMPLEMENTATION_KINDS.has(String(task.kind ?? "").toUpperCase()));
  const administrative = tasks.filter((task) => ADMINISTRATIVE_KINDS.has(String(task.kind ?? "").toUpperCase()));
  const unkinded = tasks.filter((task) => !nonEmpty(task.kind));
  if (!tasks.length) {
    findings.push(`no tasks are recorded, so nothing states what to do.`);
  } else if (!implementation.length && administrative.length === tasks.length) {
    findings.push(
      `${tasks.length === 1 ? "the only recorded task is administrative" : `all ${tasks.length} recorded tasks are administrative`} (${administrative.map((task) => task.id).join(", ")}). ` +
      `Arranging for work is not the same as the work: nothing here builds the thing the requirements describe.`
    );
  } else if (!implementation.length && unkinded.length) {
    findings.push(
      `${unkinded.length} task${unkinded.length === 1 ? "" : "s"} record${unkinded.length === 1 ? "s" : ""} no kind, so the engine cannot tell whether anything here builds the thing. ` +
      `Record --kind on each; absent is not read as implementation.`
    );
  }

  // 2. Requirements nobody is going to satisfy.
  const covered = new Set<string>();
  for (const task of tasks) for (const id of task.requirements ?? []) covered.add(String(id).toUpperCase());
  const approvedStatuses = new Set(["ACTIVE", "CONFIRMED", "APPROVED"]);
  const uncovered = requirements.filter(
    (requirement) => approvedStatuses.has(String(requirement.status).toUpperCase()) && !covered.has(String(requirement.id).toUpperCase())
  );
  if (uncovered.length) {
    const shown = uncovered.slice(0, 8).map((item) => item.id).join(", ");
    findings.push(
      `${uncovered.length} approved requirement${uncovered.length === 1 ? " has" : "s have"} no task: ${shown}${uncovered.length > 8 ? ", …" : ""}. ` +
      `A requirement nothing is going to satisfy is a promise the folder cannot keep.`
    );
  }

  // 3. Work nobody can pick up.
  const underspecified: string[] = [];
  for (const task of tasks) {
    if (ADMINISTRATIVE_KINDS.has(String(task.kind ?? "").toUpperCase())) continue;
    const missing = taskIsUnderspecified(task);
    if (missing.length >= 2) underspecified.push(`${task.id} (${missing.join(", ")})`);
  }
  if (underspecified.length) {
    findings.push(
      `${underspecified.length} task${underspecified.length === 1 ? "" : "s"} cannot be picked up as written: ${underspecified.slice(0, 6).join("; ")}${underspecified.length > 6 ? "; …" : ""}.`
    );
  }

  // 4. Who does it.
  const organization = state.execution_organization;
  if (!organization) {
    findings.push(
      `the organisation of whoever executes this has not been approved. ` +
      `One executor is a complete answer to "how many" and leaves review, handoff and stop conditions unanswered.`
    );
  } else {
    if (!nonEmpty(organization.concurrency)) findings.push(`the approved organisation does not say how concurrent changes to the same thing are prevented.`);
    if (!nonEmpty(organization.handoff)) findings.push(`the approved organisation does not say when work passes from one executor to another.`);
    if (organization.executors > 1 && !nonEmpty(organization.integrator)) {
      findings.push(`${organization.executors} executors are approved and none of them integrates: overlapping responsibility with no integrator is how two correct halves fail to become one thing.`);
    }
    if (!nonEmpty(organization.reviewer)) findings.push(`the approved organisation names no reviewer.`);
  }

  // 5. Order.
  const dependencies = state.dependencies ?? [];
  const cycle = dependencyCycle(dependencies);
  if (cycle) findings.push(`the dependencies contain a cycle: ${cycle.join(" -> ")}. Nothing in it can start.`);

  // 6. Risks carried by nobody.
  for (const risk of state.risks ?? []) {
    const status = String(risk.status ?? "").toUpperCase();
    if (status === "MITIGATED" || status === "ACCEPTED") continue;
    if (!nonEmpty(risk.owner)) findings.push(`risk ${risk.id} has no owner.`);
  }

  // 7. Where to start.
  if (!nonEmpty(state.exact_next_action)) findings.push(`no exact next action is recorded, so the folder does not say how to begin.`);

  return {
    verdict: findings.length ? "FAILED" : "PASSED",
    findings,
    remedy: findings.length
      ? [
          `These are answered by the operational interview and the work breakdown, not by more definition.`,
          `plangonaut next --project-root . proposes the first of them.`,
        ]
      : [],
  };
}

/**
 * The first cycle in a dependency graph, or null.
 *
 * Reported as the path rather than as a boolean, because "there is a cycle" is
 * not actionable and "A -> B -> C -> A" is.
 */
function dependencyCycle(dependencies: Dependency[]): string[] | null {
  const edges = new Map<string, string[]>();
  for (const dependency of dependencies) {
    if (String(dependency.type).toUpperCase() === "RELATES_TO") continue;
    const list = edges.get(dependency.from) ?? [];
    list.push(dependency.to);
    edges.set(dependency.from, list);
  }
  const state = new Map<string, number>(); // 0 unseen, 1 on stack, 2 done
  const stack: string[] = [];
  let found: string[] | null = null;
  const walk = (node: string): void => {
    if (found) return;
    state.set(node, 1);
    stack.push(node);
    for (const next of edges.get(node) ?? []) {
      if (found) return;
      const seen = state.get(next) ?? 0;
      if (seen === 1) {
        found = [...stack.slice(stack.indexOf(next)), next];
        return;
      }
      if (seen === 0) walk(next);
    }
    stack.pop();
    state.set(node, 2);
  };
  for (const node of edges.keys()) if ((state.get(node) ?? 0) === 0) walk(node);
  return found;
}

/**
 * The three verdicts, together, for every reader that shows them.
 *
 * One function so that `status`, `resume`, `next`, `validate`, `handoff-check`,
 * the context pack and the forecast cannot drift into disagreeing about the
 * same project — which is the failure mode this whole cycle is about, made by
 * the engine instead of by an agent.
 */
interface ReadinessReport {
  definition: Readiness;
  execution: Readiness;
  intent: "YES" | "NO" | "UNDECLARED";
}

function readinessReport(state: State, root?: string): ReadinessReport {
  const execution = executionReadiness(state);
  /*
   * Integrity first, and above everything a decision can reach.
   *
   * A project whose history does not reproduce its state cannot be executed,
   * whatever its plan looks like: every requirement, task and responsibility in
   * it is recorded in a file that nothing can vouch for. So the mechanical
   * failure is prepended to the execution findings rather than reported beside
   * them, and it is prepended even when the plan is otherwise perfect.
   *
   * `root` is optional only because several call sites have a state and no path.
   * Where it is known, this runs.
   */
  if (root !== undefined) {
    const diagnosis = integrityDiagnosis(root);
    if (!diagnosis.sound && diagnosis.defect) {
      const defect = diagnosis.defect;
      execution.findings.unshift(
        `mechanical integrity has failed (${defect.category}${defect.line > 0 ? `, line ${defect.line}` : ""}), so nothing recorded in this project can be relied on. ` +
        `This is not a priority call and no decision can waive it.`
      );
      execution.verdict = execution.verdict === "NOT REQUESTED" ? "NOT REQUESTED" : "FAILED";
    }
  }
  return {
    definition: definitionReadiness(state),
    execution,
    intent: executionRequested(state),
  };
}

/** The three lines every human-facing reader prints, in the same words. */
function readinessLines(report: ReadinessReport, handoff: ReadinessVerdict): string[] {
  const definition = report.definition.verdict === "PASSED" ? "substantially complete" : "incomplete";
  const execution =
    report.execution.verdict === "PASSED" ? "passed"
    : report.execution.verdict === "FAILED" ? "failed"
    : report.execution.verdict === "NOT REQUESTED" ? "not requested"
    : "not assessed";
  const handoffText = handoff === "PASSED" ? "passed" : handoff === "FAILED" ? "failed" : handoff === "NOT REQUESTED" ? "not requested" : "not assessed";
  const lines = [
    `definition: ${definition}`,
    `execution readiness: ${execution}`,
    `handoff readiness: ${handoffText}`,
  ];
  if (report.intent === "NO") {
    lines.push(
      ``,
      `Definition complete.`,
      `Execution readiness not requested.`,
      `This folder is not an execution package.`,
    );
  }
  return lines;
}

/**
 * The three modules that are about execution rather than about the project.
 *
 * Every other module is confirmed on the strength of its own interview: the
 * questions were asked, the answers were applied, the decisions they produced
 * were approved. That is the right test for "have we understood the users", and
 * it is not the right test for these three, because their subject matter is not
 * something you can finish understanding — it is something you have to have
 * *done*.
 *
 * The pilot confirmed its way to module 16 with three administrative tasks and
 * no organisation, and every module label was honest: the questions really had
 * been asked. What nothing checked is that the answers had produced a plan.
 *
 * These refuse rather than warn. Elsewhere this engine prefers to record and
 * report, because a refusal that fires on eighty-seven existing call sites is a
 * migration nobody asked for. Here the opposite holds: a confirmed module 16 is
 * the sentence a recipient trusts most, and it was the one thing in the pilot
 * that was false.
 */
function operationalModuleRefusals(root: string, state: State, moduleId: number, outcome: string): string[] {
  const refusals: string[] = [];
  const readiness = readinessReport(state);

  if (moduleId === 14) {
    /*
     * NOT APPLICABLE means "no team and no second agent", and never "nobody
     * asked". The distinction matters because the module is where responsibility
     * is recorded, and a project executed by one person still has a reviewer, a
     * handoff and a point at which work stops.
     */
    if (outcome === "NOT APPLICABLE" && !state.execution_organization) {
      refusals.push(
        `module 14 can be NOT APPLICABLE when no team and no second executor are needed, and the single executor's responsibility still has to exist. ` +
        `Record it first: plangonaut execution-org --project-root . --executors 1 --mode <human|agent|hybrid> --reviewer <who> --concurrency "<how>" --handoff "<when>" --owner <owner> --operation-id <id>.`
      );
    }
    if (outcome === "CONFIRMED" && !state.execution_organization) {
      refusals.push(
        `module 14 is about who executes this and nothing records an approved organisation. ` +
        `Propose one, have it approved, and record it with plangonaut execution-org.`
      );
    }
  }

  if (moduleId === 15 && outcome === "CONFIRMED") {
    const tasks = state.tasks ?? [];
    if (!tasks.length) refusals.push(`module 15 is the plan, and no task is recorded: there is no work breakdown to confirm.`);
    if (!(state.checkpoints ?? []).length && !(state.gates ?? []).length) refusals.push(`nothing records a milestone or a gate, so the plan has no points at which progress is checked.`);
    if (!(state.dependencies ?? []).length && tasks.length > 1) refusals.push(`${tasks.length} tasks and no recorded dependency: nothing states what has to happen before what.`);
    if (!(state.risks ?? []).length) refusals.push(`no risk is recorded, so the plan claims nothing can go wrong.`);
    const withoutAcceptance = tasks.filter((task) => !nonEmpty(task.acceptance));
    if (withoutAcceptance.length === tasks.length && tasks.length > 0) {
      refusals.push(`no task records an acceptance criterion, so nothing in the plan states how anybody would know a piece of it was finished.`);
    }
    const withoutVerification = tasks.filter((task) => !nonEmpty(task.verification) && !nonEmpty(task.evidence_expected));
    if (withoutVerification.length === tasks.length && tasks.length > 0) {
      refusals.push(`no task records a verification or the evidence it should leave behind.`);
    }
    if (!state.execution_organization) refusals.push(`nothing records who is responsible for the plan's work.`);
  }

  if (moduleId === 16 && outcome === "CONFIRMED") {
    if (readiness.definition.verdict !== "PASSED") {
      refusals.push(`the definition is not complete: ${readiness.definition.findings.join(" ")}`);
    }
    if (readiness.intent === "UNDECLARED") {
      refusals.push(
        `nobody has declared whether this project is to be built, and the final review cannot approve a blueprint without knowing which kind of thing it is. ` +
        `plangonaut execution-intent --project-root . --execution|--definition-only --reason "<why>" --owner <owner> --operation-id <id>.`
      );
    }
    if (readiness.execution.verdict === "FAILED") {
      refusals.push(`execution readiness fails: ${readiness.execution.findings.slice(0, 3).join(" ")}${readiness.execution.findings.length > 3 ? ` (and ${readiness.execution.findings.length - 3} more; plangonaut execution-readiness lists them)` : ""}`);
    }
    const proposed = (state.decisions ?? []).filter((decision) => String(decision.status).toUpperCase() === "PROPOSED");
    if (proposed.length) {
      refusals.push(`${proposed.length} decision${proposed.length === 1 ? " is" : "s are"} still PROPOSED (${proposed.slice(0, 5).map((item) => item.id).join(", ")}${proposed.length > 5 ? ", …" : ""}), so the blueprint rests on choices nobody has taken.`);
    }
    if (state.needs_reconciliation) refusals.push(`an override is open and unreconciled, so the project's direction is not settled.`);
  }

  return refusals;
}

function moduleConfirmationBlockers(state: State, moduleId: number): string[] {
  const blockers: string[] = [];
  const entries = interviewLog(state).filter((entry) => entry.module === moduleId);

  /*
   * The emptiest case, and the one the synthetic pilot walked straight into: a
   * module with nothing recorded against it at all, confirmed by handing the
   * command a summary the agent had just written about its own reading.
   *
   * Every other blocker below asks whether the work on a module is finished.
   * This one asks whether any happened. `CONFIRMED` says the project may build
   * on this module; a module nobody asked anything about supports nothing.
   *
   * The way past it is not a trick: `NOT APPLICABLE` or `DEFERRED`, with the
   * reason in the answer file. Both are honest and both stay available, which
   * is why this can be a refusal rather than a warning.
   */
  const settledHere = entries.filter(
    (entry) => entry.status === "ANSWERED" && nonEmpty(entry.consequences_recorded_at),
  );
  // Module 0 is the collaboration contract, and `init` confirms it from the
  // owners file: that *is* its coverage, recorded before any question could be
  // asked. Reported as missing coverage it would fire on every project ever
  // created, which is how a check teaches people to ignore it.
  if (moduleId !== 0 && !settledHere.length) {
    blockers.push(
      `nothing is recorded against it: no question on this module has been asked and applied, so there is no coverage to confirm. ` +
      `If it genuinely does not apply, record NOT_APPLICABLE with the reason; if it is being left for later, record DEFERRED.`
    );
  }

  const open = entries.filter(
    (entry) =>
      entry.status === "PLANNED" ||
      entry.status === "ASKED" ||
      (entry.status === "ANSWERED" && !nonEmpty(entry.consequences_recorded_at)),
  );
  for (const entry of open) {
    blockers.push(
      `${entry.id} is ${entry.status}${entry.status === "ANSWERED" ? " and not applied" : ""}: ` +
      `${entry.status === "ANSWERED" ? "settle it with qa-settle" : entry.status === "ASKED" ? "record the answer with qa-answer, or close it with qa-close" : "ask it, or close it with qa-close"}.`
    );
  }

  const named = new Set<string>();
  for (const entry of entries) {
    if (!nonEmpty(entry.consequences_recorded_at)) continue;
    for (const consequence of entry.consequences ?? []) named.add(consequence);
  }
  for (const decision of state.decisions ?? []) {
    if (!named.has(decision.id)) continue;
    const status = String(decision.status).toUpperCase();
    if (status === "PROPOSED") {
      blockers.push(
        `decision ${decision.id} came out of this module's interview and is still PROPOSED: ` +
        `approve it with a recorded provenance, reject it, or supersede it.`
      );
      continue;
    }
    if (status === "APPROVED" && !(decision as any).provenance && !findDecisionProvenance(state, decision.id)) {
      blockers.push(
        `decision ${decision.id} is APPROVED and records no provenance, so the module would rest on an approval nobody can trace.`
      );
    }
  }
  return blockers;
}

// ---------------------------------------------------------------------------
// The typed ledger and the prose about it
// ---------------------------------------------------------------------------

/** Identifiers a governed document can cite, and the ledger they must be in. */
const CITED_IDENTIFIER = /\b(DEC|REQ|TSK|RSK|DEP|EVD|AGT|BLK|CHK)-[A-Z0-9][A-Z0-9_-]*/g;

/**
 * Where a document says one thing and the ledger says another.
 *
 * The pilot's folder read as though decisions had been taken and risks
 * registered, and `decisions: 0`, `risks: 0` were the actual numbers. Prose is
 * where a project's reasoning lives and there is nothing wrong with that; what
 * is wrong is prose that *claims a record*. A document naming `DEC-0007` is
 * telling a reader to go and find `DEC-0007`.
 *
 * Deterministic on purpose: an identifier matching the ledger's own id pattern,
 * cited in a governed document, that no record answers to. No natural-language
 * inference, no keyword lists, nothing that would fire on ordinary writing.
 */
function ledgerCoherenceFindings(root: string, state: State): string[] {
  const findings: string[] = [];
  const known = knownRecordIds(state);

  const documents = new Set<string>();
  for (const artifact of state.artifacts ?? []) {
    for (const value of [artifact.working_path, artifact.base_path]) {
      if (nonEmpty(value)) documents.add(canonicalRelative(String(value)));
    }
  }
  for (const relative of [...documents].sort()) {
    const absolute = existingFileInside(root, relative);
    if (!absolute) continue;
    const text = fs.readFileSync(absolute, "utf8");
    const cited = new Set<string>();
    for (const match of text.matchAll(CITED_IDENTIFIER)) {
      // The document's own artifact id is not a claim about another ledger.
      if (match[0].startsWith("ART-")) continue;
      cited.add(match[0]);
    }
    const missing = [...cited].filter((id) => !known.has(id)).sort();
    if (missing.length) {
      findings.push(
        `${relative} cites ${missing.join(", ")}, which ${missing.length === 1 ? "is not a record" : "are not records"} in this project. ` +
        `A document that names an identifier is telling a reader to go and find it; record ${missing.length === 1 ? "it" : "them"}, or write the sentence without the identifier.`
      );
    }
  }

  for (const module of state.modules ?? []) {
    if (String(module.status).toUpperCase() !== "CONFIRMED") continue;
    const blockers = moduleConfirmationBlockers(state, module.id);
    for (const blocker of blockers) {
      findings.push(`module ${module.id} is CONFIRMED, and ${blocker}`);
    }
  }

  findings.push(...unprovenancedApprovals(state));
  return findings;
}

/*
 * Everything that makes "carry on as normal" the wrong thing to say.
 *
 * The synthetic pilot put the case plainly: module 1 was CONFIRMED over two of
 * its own open questions and an approval nobody could trace, `handoff-check`
 * refused the folder, `validate --strict` failed -- and `next`, `status` and the
 * recorded action all said "Discuss module 2". Each was individually correct and
 * together they invited an agent to build on a foundation the same tool had just
 * refused. A tool that knows better and says nothing where the reader is looking
 * is the defect this cycle is about.
 *
 * So one list, computed from the same findings `validate --strict` fails on, and
 * shown first everywhere a next step is offered. It never refuses: the way out
 * is to resolve the contradiction or to downgrade the claim -- NOT_APPLICABLE
 * and DEFERRED are honest, and PROPOSED is always available -- and both of those
 * are writes.
 */
function advanceHoldFromState(state: State): string[] {
  const findings: string[] = [];
  for (const module of state.modules ?? []) {
    if (String(module.status).toUpperCase() !== "CONFIRMED") continue;
    for (const blocker of moduleConfirmationBlockers(state, module.id)) {
      findings.push(`module ${module.id} is CONFIRMED, and ${blocker}`);
    }
  }
  findings.push(...unprovenancedApprovals(state));
  return findings;
}

/** The same, plus what only a look at the folder can tell. */
function advanceHold(root: string, state: State): string[] {
  const findings = advanceHoldFromState(state);
  try {
    findings.push(...unclaimedDocumentReport(root, state).findings);
  } catch {
    // A folder that cannot be walked is not a reason to withhold the rest.
  }
  return findings;
}

/** The block every command prints before it offers a next step. */
function advanceHoldLines(findings: string[]): string[] {
  if (!findings.length) return [];
  return [
    `FIRST: ${findings.length} recorded contradiction${findings.length === 1 ? "" : "s"} ${findings.length === 1 ? "stands" : "stand"} between this project and any next step.`,
    ...findings.map((line) => `- ${line}`),
    `Resolve them, or downgrade the claim that is not true yet: a module can be NOT_APPLICABLE or DEFERRED with its reason, and a decision can be PROPOSED.`,
    `plangonaut validate --strict fails on this list, and plangonaut handoff-check refuses the folder while it stands.`,
  ];
}

/** The recorded sentence, when the ledger contradicts itself. */
function advanceHoldAction(count: number): string {
  return `Resolve ${count} recorded contradiction${count === 1 ? "" : "s"} before continuing; plangonaut validate --strict lists them.`;
}

/** A state that predates the ledger gets the empty one, in memory, on read. */
function interviewLog(state: any): InterviewEntry[] {
  return Array.isArray(state.interview_log) ? state.interview_log : [];
}

function findInterviewEntry(state: any, id: string): InterviewEntry | undefined {
  return interviewLog(state).find((entry) => entry.id === id);
}

/** Accepts `7`, `QNA-7` and `QNA-0007`; records the padded form, always. */
function normalizeQuestionId(value: string): string {
  const trimmed = String(value).trim().toUpperCase();
  const bare = trimmed.startsWith("QNA-") ? trimmed.slice(4) : trimmed;
  if (!/^[0-9]+$/.test(bare)) throw new PlangonautError(`Invalid question id: ${value}. Use QNA-0007, or 7.`);
  const padded = `QNA-${bare.padStart(4, "0")}`;
  if (!QA_ID_PATTERN.test(padded)) throw new PlangonautError(`Invalid question id: ${value}`);
  return padded;
}

/**
 * A value supplied inline or in a file, never both.
 *
 * The file form exists because an exact answer is the one field that must not be
 * reshaped by a shell: a multi-line reply with quotes in it survives a file and
 * does not always survive an argument list.
 */
function textOrFile(flags: Flags, name: string, label: string, optional = false): string | null {
  const inline = flags[name];
  const fromFile = flags[`${name}-file`];
  if (nonEmpty(inline) && nonEmpty(fromFile)) throw new PlangonautError(`Pass either --${name} or --${name}-file for ${label}, not both`);
  if (nonEmpty(inline)) return String(inline).trim();
  if (nonEmpty(fromFile)) {
    const resolved = path.resolve(String(fromFile));
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) throw new PlangonautError(`${label} file does not exist: ${resolved}`);
    const text = fs.readFileSync(resolved, "utf8").trim();
    if (!text) throw new PlangonautError(`${label} file is empty: ${resolved}`);
    return text;
  }
  if (optional) return null;
  throw new PlangonautError(`${label} is required: pass --${name} or --${name}-file`);
}

function listFlag(flags: Flags, name: string): string[] {
  const raw = flags[name];
  if (!nonEmpty(raw)) return [];
  const items = String(raw).split(",").map((value) => value.trim()).filter(Boolean);
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item)) throw new PlangonautError(`--${name} repeats ${item}`);
    seen.add(item);
  }
  return items;
}

/** The record behind a consequence id, for the checks that need its timestamp. */
function recordById(state: any, id: string): any {
  const ledgers = [
    state.decisions, state.requirements, state.artifacts, state.tasks, state.dependencies,
    state.risks, state.evidence, state.agents, state.checkpoints, state.gates,
  ];
  for (const ledger of ledgers) {
    const found = (ledger ?? []).find((item: any) => String(item?.id) === id);
    if (found) return found;
  }
  return null;
}

/** Ledger ids a consequence may name. A consequence pointing nowhere is refused. */
function knownRecordIds(state: any): Set<string> {
  return new Set(
    [
      ...(state.decisions ?? []), ...(state.requirements ?? []), ...(state.artifacts ?? []),
      ...(state.tasks ?? []), ...(state.dependencies ?? []), ...(state.risks ?? []),
      ...(state.evidence ?? []), ...(state.agents ?? []), ...(state.checkpoints ?? []),
      ...(state.gates ?? []),
    ].map((item: any) => String(item.id))
  );
}

/**
 * Everything wrong with the interview ledger, in the caller's words.
 *
 * Chronological order is checked against `created_at` rather than against array
 * position alone: a hand-edited state that reorders entries is the case the
 * brief asks for, and position would accept it.
 */
function interviewLogErrors(root: string, state: any): string[] {
  const errors: string[] = [];
  if (!Array.isArray(state.interview_log)) {
    errors.push("interview_log must be an array");
    return errors;
  }
  const entries: InterviewEntry[] = state.interview_log;
  const byId = new Map<string, InterviewEntry>();
  let priorCreated = "";

  for (const [index, entry] of entries.entries()) {
    const where = `interview_log[${index}]`;
    if (!nonEmpty(entry?.id) || !QA_ID_PATTERN.test(entry.id)) {
      errors.push(`${where} has an invalid id`);
      continue;
    }
    if (byId.has(entry.id)) errors.push(`duplicate interview entry ${entry.id}`);
    byId.set(entry.id, entry);

    if (!QA_STATUSES.has(entry.status)) errors.push(`${entry.id} has unknown status ${entry.status}`);
    if (!nonEmpty(entry.question)) errors.push(`${entry.id} has no question`);
    if (!nonEmpty(entry.rationale)) errors.push(`${entry.id} has no rationale`);
    if (!nonEmpty(entry.owner)) errors.push(`${entry.id} has no owner`);
    if (!nonEmpty(entry.created_at)) errors.push(`${entry.id} has no created_at`);
    else {
      if (priorCreated && entry.created_at < priorCreated) errors.push(`${entry.id} is out of chronological order: created ${entry.created_at} after ${priorCreated}`);
      priorCreated = entry.created_at;
    }

    // The states the brief requires Resume to tell apart, enforced rather than
    // described: an answer with no timestamp, or consequences recorded for an
    // answer that does not exist, would make an interrupted turn look finished.
    if (entry.status === "ANSWERED") {
      if (!nonEmpty(entry.answer)) errors.push(`${entry.id} is ANSWERED with no recorded answer`);
      if (!nonEmpty(entry.answered_at)) errors.push(`${entry.id} is ANSWERED with no answered_at`);
      if (!nonEmpty(entry.asked_at)) errors.push(`${entry.id} is ANSWERED but was never recorded as asked`);
    }
    if (entry.status === "ASKED" && nonEmpty(entry.answer)) errors.push(`${entry.id} is ASKED but carries an answer`);
    if (entry.status === "PLANNED" && nonEmpty(entry.asked_at)) errors.push(`${entry.id} is PLANNED but carries asked_at`);
    /*
     * The guarantee is "an unanswered question can never look applied", not "an
     * applied answer can never be superseded". The first version of this rule
     * demanded `ANSWERED`, which made a correction impossible: superseding a
     * settled entry moves it to `SUPERSEDED` while it rightly keeps the
     * consequences it had. The engine refused the first `qa-supersede` and was
     * pointing at the rule, not at the operation.
     */
    if (nonEmpty(entry.consequences_recorded_at) && new Set(["PLANNED", "ASKED", "DEFERRED", "SKIPPED"]).has(entry.status)) {
      errors.push(`${entry.id} is ${entry.status} and records applied consequences; only an answered question can have been applied`);
    }
    if (nonEmpty(entry.consequences_recorded_at) && !nonEmpty(entry.answer)) errors.push(`${entry.id} records consequences for an answer that is not there`);
    if (new Set(["DEFERRED", "SKIPPED", "INVALIDATED"]).has(entry.status) && !nonEmpty(entry.closed_reason)) errors.push(`${entry.id} is ${entry.status} without a recorded reason`);
    if (entry.status === "SUPERSEDED" && !nonEmpty(entry.superseded_by)) errors.push(`${entry.id} is SUPERSEDED without naming what replaced it`);
    if (entry.reconstructed !== true && entry.reconstructed !== false) errors.push(`${entry.id} does not say whether it was reconstructed`);
    if (entry.reconstructed === true && !nonEmpty(entry.reconstructed_from)) errors.push(`${entry.id} claims to be reconstructed and names no evidence`);
    if (entry.reconstructed !== true && nonEmpty(entry.reconstructed_from)) errors.push(`${entry.id} names reconstruction evidence without being marked reconstructed`);
  }

  const records = knownRecordIds(state);
  for (const entry of entries) {
    if (!nonEmpty(entry?.id)) continue;
    for (const field of ["supersedes", "superseded_by", "next_id"] as const) {
      const target = entry[field];
      if (nonEmpty(target) && !byId.has(String(target))) errors.push(`${entry.id}.${field} points at ${target}, which is not in the ledger`);
    }
    if (nonEmpty(entry.superseded_by) && entry.status !== "SUPERSEDED") errors.push(`${entry.id} names a replacement while not SUPERSEDED`);
    for (const consequence of entry.consequences ?? []) {
      if (!records.has(consequence)) errors.push(`${entry.id} records consequence ${consequence}, which is not a record in this project`);
    }
    for (const document of entry.documents ?? []) {
      if (!nonEmpty(document)) errors.push(`${entry.id} records an empty document path`);
    }
  }

  /*
   * State's agreement with itself is checked here; its agreement with the file on
   * disk is not, and that split is load-bearing.
   *
   * `stateErrors` runs inside every transaction, before anything is written. The
   * derived document is written *after* the commit, because the ledger is the
   * record and a view that failed to write must not roll back a recorded answer.
   * Checking the file here made the first `qa-ask` on a new project refuse itself:
   * the digest was in the state being validated and the file it describes did not
   * exist yet. The engine caught it on the first run, which is the right place for
   * it to be caught, and the on-disk comparison now lives in
   * `interviewViewErrors`, called by `validate`.
   */
  if (state.interview_view !== undefined && state.interview_view !== null) {
    const view = state.interview_view;
    if (view.path !== QA_VIEW_RELATIVE) errors.push(`interview_view.path must be ${QA_VIEW_RELATIVE}`);
    if (!nonEmpty(view.sha256)) errors.push("interview_view.sha256 is missing");
    else if (sha256(renderInterviewView(state)) !== view.sha256) {
      errors.push(`interview_view.sha256 does not describe what this state renders; regenerate with: plangonaut qa-log --project-root . --regenerate`);
    }
  }

  return errors;
}

/**
 * Whether the derived document on disk still matches the ledger.
 *
 * Separate from `interviewLogErrors` because it is a fact about the filesystem
 * rather than about the state, and because it must not run inside a transaction:
 * see the comment above. A hand edit to the document is reported here, with the
 * one command that repairs it, and nothing about the recorded history changes.
 */
function interviewViewErrors(root: string, state: any): string[] {
  const view = state.interview_view;
  if (view === undefined || view === null || !nonEmpty(view.sha256)) return [];
  const file = path.join(root, QA_VIEW_RELATIVE);
  if (!fs.existsSync(file)) return [`${QA_VIEW_RELATIVE} is recorded in state and missing from the project; regenerate with: plangonaut qa-log --project-root . --regenerate`];
  if (sha256(fs.readFileSync(file)) !== view.sha256) {
    return [`${QA_VIEW_RELATIVE} was edited outside Plangonaut. It is a derived view: the history is in the project ledger, so nothing in it was changed by that edit. Regenerate with: plangonaut qa-log --project-root . --regenerate`];
  }
  return [];
}

// ---------------------------------------------------------------------------
// The derived document
// ---------------------------------------------------------------------------

function quoteBlock(value: string): string[] {
  return String(value).split(/\r?\n/).map((line) => (line.trim() ? `> ${line}` : ">"));
}

/** What the entry is, in one line, including whether the answer was applied. */
function entryHeadline(entry: InterviewEntry): string {
  if (entry.status !== "ANSWERED") return entry.status;
  return entry.consequences_recorded_at ? "ANSWERED, applied" : "ANSWERED, not yet applied";
}

/**
 * The whole document, as a pure function of state.
 *
 * Pure on purpose: no clock, no environment. Regenerating it twice produces the
 * same bytes, so the digest in state is stable and a difference on disk means
 * somebody edited the file rather than that time passed.
 */
function renderInterviewView(state: any): string {
  const entries = interviewLog(state);
  const moduleTitle = (id: number | null) => {
    if (id === null || id === undefined) return null;
    const module = (state.modules ?? []).find((item: any) => item.id === id);
    return module ? `${id} — ${module.title}` : String(id);
  };

  const lines: string[] = [
    "# Question and answer history",
    "",
    "<!-- Generated by Plangonaut from the project ledger. Do not edit this file. -->",
    "<!-- Regenerate with: plangonaut qa-log --project-root . --regenerate -->",
    "",
    `- Project: ${state.project?.name ?? "not recorded"}`,
    `- History recorded since: ${state.interview_log_since ?? "not recorded"}`,
    `- Interactions: ${entries.length}`,
    "",
    "This is the record of what Plangonaut asked, what you answered, and what",
    "Plangonaut did with the answer. It is append-only: a correction adds an entry",
    "that supersedes the earlier one, and the earlier one stays where it is.",
    "",
    "It is a **derived view**, regenerated from the project state. Editing this file",
    "changes nothing and is reported by `plangonaut validate`; the history lives in",
    "`.plangonaut/state.json`, with `.plangonaut/events.jsonl` recording how it got",
    "there \u2014 or in `.beave/`, under those same two names, in a project created",
    "before the rename.",
    "",
  ];

  if (!entries.length) {
    lines.push("## No interaction recorded yet", "");
    lines.push(
      state.interview_log_since
        ? `Nothing has been asked through Plangonaut since ${state.interview_log_since}. Interactions from before that instant, if any, were never recorded and are not reconstructed here.`
        : "Nothing has been recorded yet.",
      ""
    );
  }

  for (const entry of entries) {
    lines.push(`## ${entry.id} — ${entryHeadline(entry)}`, "");
    lines.push(`- Status: ${entry.status}`);
    lines.push(
      `- Consequences recorded: ${
        entry.consequences_recorded_at ??
        (nonEmpty(entry.answer)
          ? "not yet — the answer is recorded and has not been applied to the project records"
          : "nothing to apply — no answer is recorded")
      }`
    );
    lines.push(
      `- Module: ${moduleTitle(entry.module) ?? "not recorded"}${entry.crosscutting === true ? " — asked outside the module the interview was on" : ""}`,
    );
    if (entry.crosscutting === true) {
      lines.push(`- Why it was asked there: ${entry.crosscutting_reason ?? "not recorded"}`);
    }
    lines.push(`- Phase: ${entry.lifecycle_state} · Gate: ${entry.gate}`);
    lines.push(`- Asked by: ${entry.agent ?? "not recorded"}`);
    if (nonEmpty(entry.answered_by_agent)) lines.push(`- Answer recorded by: ${entry.answered_by_agent}`);
    if (entry.reconstructed && nonEmpty(entry.reconstructed_from)) lines.push(`- Reconstructed from: ${entry.reconstructed_from}`);
    lines.push(`- Recorded by: ${entry.owner}`);
    lines.push(`- Asked at: ${entry.asked_at ?? "not asked"}`);
    lines.push(`- Answered at: ${entry.answered_at ?? "no answer recorded"}`);
    if (entry.supersedes) lines.push(`- Replaces: ${entry.supersedes}`);
    if (entry.superseded_by) lines.push(`- Replaced by: ${entry.superseded_by}`);
    if (entry.reconstructed) lines.push("- **Reconstructed from durable evidence**, not recorded at the time it happened.");
    lines.push("");

    lines.push("**Question**", "", ...quoteBlock(entry.question), "");
    lines.push("**Why it was asked**", "", entry.rationale, "");

    if (nonEmpty(entry.answer)) lines.push("**Answer, verbatim**", "", ...quoteBlock(entry.answer as string), "");
    else lines.push("**Answer**", "", "No answer is recorded for this question.", "");

    if (nonEmpty(entry.interpretation)) lines.push("**What Plangonaut understood**", "", entry.interpretation as string, "");
    if (nonEmpty(entry.reply)) lines.push("**What Plangonaut replied**", "", entry.reply as string, "");
    if (nonEmpty(entry.closed_reason)) lines.push("**Why it was closed**", "", entry.closed_reason as string, "");

    if ((entry.consequences ?? []).length) lines.push("**Records created or changed**", "", ...entry.consequences.map((id) => `- ${id}`), "");
    if ((entry.documents ?? []).length) lines.push("**Documents**", "", ...entry.documents.map((item) => `- ${item}`), "");
    if ((entry.open_points ?? []).length) lines.push("**Still open**", "", ...entry.open_points.map((item) => `- ${item}`), "");

    if (nonEmpty(entry.next_question) || nonEmpty(entry.next_id)) {
      const nextEntry = entry.next_id ? findInterviewEntry(state, entry.next_id) : undefined;
      lines.push(
        "**Next question proposed**",
        "",
        `- ${entry.next_id ?? "not yet opened"} (${nextEntry ? nextEntry.status : "not yet opened"}): ${entry.next_question ?? (nextEntry ? nextEntry.question : "not recorded")}`,
        ""
      );
    }
    lines.push("---", "");
  }

  const open = openInterviewEntries(state);
  lines.push("## Open right now", "");
  if (!open.asked.length && !open.unapplied.length && !open.planned.length) lines.push("- Nothing open: every recorded question is answered and applied.", "");
  else {
    for (const entry of open.asked) lines.push(`- ${entry.id} was asked and has no answer.`);
    for (const entry of open.unapplied) lines.push(`- ${entry.id} was answered and the answer is not applied yet.`);
    for (const entry of open.planned) lines.push(`- ${entry.id} is planned and has not been asked.`);
    lines.push("");
  }

  return lines.join("\n");
}

/** The three kinds of unfinished business, which Resume has to tell apart. */
function openInterviewEntries(state: any): { planned: InterviewEntry[]; asked: InterviewEntry[]; unapplied: InterviewEntry[] } {
  const entries = interviewLog(state);
  return {
    planned: entries.filter((entry) => entry.status === "PLANNED"),
    asked: entries.filter((entry) => entry.status === "ASKED"),
    unapplied: entries.filter((entry) => entry.status === "ANSWERED" && !nonEmpty(entry.consequences_recorded_at)),
  };
}

/**
 * Write the document and record its digest in the state about to be committed.
 *
 * Called before `commitState`, so the digest travels in the same transaction as
 * the entry it describes. The file itself is written after the commit: the
 * ledger is the record, and a file that failed to write is a stale view that
 * `validate` reports and one command repairs -- which is the right way round.
 */
function stampInterviewView(state: any): string {
  const rendered = renderInterviewView(state);
  state.interview_view = { path: QA_VIEW_RELATIVE, sha256: sha256(rendered) };
  return rendered;
}

function writeInterviewView(root: string, rendered: string): void {
  atomicWrite(path.join(root, QA_VIEW_RELATIVE), Buffer.from(rendered, "utf8"), root);
}

/**
 * Every qa command ends the same way, so the ending is written once.
 *
 * The document is written inside the transaction, and the journal is told that
 * this operation regenerates a view: an interruption between the state write and
 * the document leaves a state recording a digest for a file that is not there,
 * and recovery rebuilds it rather than leaving `validate` to refuse.
 */
function commitInterview(root: string, location: string, state: any, event: any): void {
  const rendered = stampInterviewView(state);
  state.updated_at = event.at;
  state.revision = event.state_revision;
  state.last_event_id = event.event_id;
  const owned = activeTransaction === null;
  const directory = owned ? beginFileTransaction(root, event, [path.join(root, QA_VIEW_RELATIVE)]) : activeTransaction!.directory;
  try {
    commitState(root, location, state, event, { views: true });
    writeInterviewView(root, rendered);
    faultPoint("after-view");
    if (owned) completeFileTransaction(directory);
  } catch (error) {
    if (owned && fs.existsSync(directory)) rollbackFileTransaction(root, directory);
    throw error;
  }
}

function beginInterviewEvent(state: any, type: string, key: string, extra: Record<string, unknown>): any {
  const at = now();
  return { event_id: crypto.randomUUID(), type, state_revision: state.revision + 1, at, idempotency_key: key, ...extra };
}

/**
 * The ledger must exist before it can be written to.
 *
 * A project created before this feature has no `interview_log`. It is created
 * empty on first write, with the marker set to that instant: what came before is
 * not reconstructed and is not claimed to be absent either.
 */
/**
 * The ledger must exist before it can be written to, and the type has to know.
 *
 * The return value is the array rather than `void`: `state.interview_log` is
 * optional by design, so every caller would otherwise need a non-null assertion
 * and one of them would eventually be wrong.
 */
function ensureInterviewLog(state: any, at: string): InterviewEntry[] {
  if (!Array.isArray(state.interview_log)) {
    state.interview_log = [];
    state.interview_log_since = at;
  }
  if (state.interview_log_since === undefined) state.interview_log_since = at;
  return state.interview_log;
}

/**
 * Which module a question belongs to, and whether that is a deviation.
 *
 * The rule, in one place:
 *
 *  - no `--module` means the module the interview is actually on. A question
 *    with no module at all was how the two pilots ended up with QNA-0001 and
 *    QNA-0002 recorded against module 2 while `active_module` said 1, and
 *    nothing in either folder explained it.
 *  - a module that is *not* the active one is a deviation. It is allowed — a
 *    question genuinely can cut across modules, or reopen an earlier one — but
 *    it has to be asked for with `--crosscutting` and a `--crosscutting-reason`,
 *    it is recorded on the entry, and Resume shows it as a deviation rather than
 *    as ordinary progress.
 *  - either way the active module does **not** move. A module can take several
 *    questions, so advancing on an answer would be guessing; the module advances
 *    when it is recorded in a terminal state, and nowhere else.
 */
function resolveQuestionModule(
  state: any,
  flags: Flags,
): { module: number | null; crosscutting: boolean; reason: string | null } {
  const active = activeModule(state);
  const asked = moduleFlag(state, flags.module);
  const wantsDeviation = flags.crosscutting === true;
  const reason = nonEmpty(flags["crosscutting-reason"]) ? String(flags["crosscutting-reason"]).trim() : null;

  if (asked === null) {
    if (wantsDeviation || reason) {
      throw new PlangonautError(
        `--crosscutting describes a question that belongs to a module other than the one the interview is on, so it needs --module as well. Nothing was written.`,
      );
    }
    // No module recorded anywhere is the state that produced the pilots'
    // discrepancy. The active module is the honest default.
    return { module: active ? active.id : null, crosscutting: false, reason: null };
  }

  if (active && asked !== active.id) {
    if (!wantsDeviation) {
      throw new PlangonautError(
        `Module ${asked} is not the module this interview is on (${active.id} — ${active.title}, ${active.status}). ` +
          `Recording a question against a later module makes the earlier ones look settled when they are not, and against an earlier one hides that you are reopening it. ` +
          `If the question really belongs there, say so: add --crosscutting --crosscutting-reason "<why>". ` +
          `If module ${active.id} is finished, record it first with \`plangonaut record\`. Nothing was written.`,
      );
    }
    if (!reason) {
      throw new PlangonautError(`--crosscutting needs --crosscutting-reason: a deviation nobody explained is a deviation nobody can review. Nothing was written.`);
    }
    return { module: asked, crosscutting: true, reason };
  }

  if (wantsDeviation) {
    throw new PlangonautError(
      `Module ${asked} is the module this interview is on, so --crosscutting describes nothing. Drop it. Nothing was written.`,
    );
  }
  return { module: asked, crosscutting: false, reason: null };
}

function moduleFlag(state: any, raw: unknown): number | null {
  if (!nonEmpty(raw) && typeof raw !== "number") return null;
  const moduleId = Number(raw);
  if (!Number.isInteger(moduleId) || !(state.modules ?? []).some((item: any) => item.id === moduleId)) {
    throw new PlangonautError(`Unknown module: ${raw}`);
  }
  return moduleId;
}

interface NewEntryInput {
  id: string;
  question: string;
  rationale: string;
  module: number | null;
  crosscutting: boolean;
  crosscuttingReason: string | null;
  agent: string | null;
  owner: string;
  planned: boolean;
  reconstructed: boolean;
  reconstructedFrom: string | null;
}

function newInterviewEntry(state: any, input: NewEntryInput, at: string): InterviewEntry {
  return {
    id: input.id,
    status: input.planned ? "PLANNED" : "ASKED",
    module: input.module,
    crosscutting: input.crosscutting === true,
    crosscutting_reason: input.crosscutting === true ? (input.crosscuttingReason ?? null) : null,
    lifecycle_state: state.lifecycle_state,
    gate: state.current_gate,
    agent: input.agent,
    answered_by_agent: null,
    owner: input.owner,
    question: input.question,
    rationale: input.rationale,
    asked_at: input.planned ? null : at,
    answer: null,
    answered_at: null,
    interpretation: null,
    reply: null,
    consequences: [],
    documents: [],
    open_points: [],
    consequences_recorded_at: null,
    next_id: null,
    next_question: null,
    supersedes: null,
    superseded_by: null,
    closed_reason: null,
    reconstructed: input.reconstructed,
    reconstructed_from: input.reconstructedFrom,
    created_at: at,
    updated_at: at,
  };
}

/**
 * Why `qa-ask` refused an id, in the words of what that id is currently doing.
 *
 * One sentence used to answer for all seven statuses: *"already exists. Use
 * qa-supersede to replace it; the history is append-only."* On a `SUPERSEDED` or
 * an `ANSWERED` entry that is sound advice. On a `PLANNED` one it is wrong in a
 * way that damages the record, and `PLANNED` is the status the engine itself
 * creates: `qa-settle --next-id` writes the next question ahead of time, so the
 * agent that then goes to ask it meets its own planned entry and is told to
 * supersede it.
 *
 * Superseding is the correction of a *wrong answer*. Applied to a question that
 * was never put, it manufactures a chain — `supersedes`/`superseded_by`, a
 * reason, an event — documenting a correction that never happened, and the
 * folder's reader has no way to tell that from a real one. In the pilot this
 * happened three times in one session, and was caught only because a human
 * remembered the question had never been asked.
 *
 * So the refusal names the status and the action the protocol actually defines
 * for it. Nothing about append-only history changes: an entry still cannot be
 * rewritten, and the only status that ever wanted `qa-supersede` still gets it.
 */
function duplicateQuestionRefusal(entry: InterviewEntry): string {
  const head = `Question ${entry.id} already exists, as ${entry.status}.`;
  const tail = `Nothing was written.`;
  const answer =
    `plangonaut qa-answer --project-root . --id ${entry.id} --answer-file <file> --owner <owner> --operation-id <id>`;
  switch (entry.status) {
    case "PLANNED":
      return (
        `${head} It was written ahead of time — by qa-settle --next-id, or by qa-ask --planned — and has not been put to anyone yet, ` +
        `so there is no answer to correct and nothing to supersede.\n` +
        `Ask it, then record what came back:\n  ${answer}\n` +
        `qa-answer accepts a PLANNED entry and stamps asked_at itself. ${tail}`
      );
    case "ASKED":
      return (
        `${head} It has been put and is waiting for an answer, so it is already open; asking again would not change the record.\n` +
        `Record the answer when it arrives:\n  ${answer}\n` +
        `If it will not be answered, close it with qa-close --kind deferred|skipped and a reason. ${tail}`
      );
    case "ANSWERED":
      // There is no `SETTLED` status, and inventing one in a message would
      // describe a vocabulary the ledger does not have. Settled is `ANSWERED`
      // with `consequences_recorded_at` written, so the two cases are told apart
      // by the field that actually distinguishes them.
      return nonEmpty(entry.consequences_recorded_at)
        ? `${head} Its answer was applied at ${entry.consequences_recorded_at}, so the interaction is closed.\n` +
          `To correct that answer, use qa-supersede — it keeps this entry and records what replaced it:\n` +
          `  plangonaut qa-supersede --project-root . --id ${entry.id} --new-id <QNA-NNNN> --question "..." --rationale "..." --reason "..." --owner <owner> --operation-id <id>\n` +
          `To ask something new, open it under an id of its own. ${tail}`
        : `${head} Its answer is recorded but not yet applied.\n` +
          `Apply it:  plangonaut qa-settle --project-root . --id ${entry.id} --interpretation "..." --reply-file <file> --owner <owner> --operation-id <id>\n` +
          `To correct the answer itself, use qa-supersede: the history is append-only. ${tail}`;
    case "SUPERSEDED":
      return (
        `${head} It was already replaced${nonEmpty(entry.superseded_by) ? ` by ${entry.superseded_by}` : ""}, and a superseded entry is kept as history.\n` +
        `Open the new question under an id of its own. ${tail}`
      );
    case "DEFERRED":
    case "SKIPPED":
    case "INVALIDATED":
      return (
        `${head} It was closed without an answer${nonEmpty(entry.closed_reason) ? `: ${entry.closed_reason}` : ""}.\n` +
        `Reopening it means asking it again under a new id, so the closure stays readable. ${tail}`
      );
    default:
      // A status this build does not know about: say so rather than guess an
      // action for it. `qa-settle`'s applied entries arrive here.
      return (
        `${head} There is no reopening in place; the history is append-only.\n` +
        `Correct a recorded answer with qa-supersede, or open a new question under an id of its own. ${tail}`
      );
  }
}

/** The shape `qa-ask` and `qa-supersede` both build from the caller's flags. */
function entryInputFromFlags(state: any, flags: Flags, id: string, planned: boolean): NewEntryInput {
  const questionModule = resolveQuestionModule(state, flags);
  return {
    id,
    question: textOrFile(flags, "question", "Question") as string,
    rationale: textOrFile(flags, "rationale", "Rationale") as string,
    module: questionModule.module,
    crosscutting: questionModule.crosscutting,
    crosscuttingReason: questionModule.reason,
    agent: nonEmpty(flags.agent) ? String(flags.agent).trim() : null,
    owner: String(flags.owner).trim(),
    planned,
    reconstructed: flags.reconstructed === true,
    reconstructedFrom: nonEmpty(flags["reconstructed-from"]) ? canonicalRelative(String(flags["reconstructed-from"])) : null,
  };
}

function qaAsk(flags: Flags): void {
  const root = resolveProject(required(flags, "project-root"));
  const key = idempotencyKey(flags);
  if (checkIdempotency(root, key)) return console.log(`Idempotent retry: question already recorded.`);
  const { location, state } = loadState(root);
  // Opening a *new* question while a human override is unreconciled is exactly
  // what `plangonaut next` already refuses. Answering one already in flight is not.
  assertNotBlocked(state);
  /*
   * And the same for an unfinished settlement.
   *
   * "Complete or reconcile that transaction before putting a new question" was
   * advice printed by Resume, which means it held exactly as long as the next
   * agent read it. Here it is a refusal, so the half-applied state cannot be
   * buried under a newer question by an agent that did not read carefully.
   * Answering and settling are not blocked: closing out work in flight is the
   * thing this refusal exists to make happen.
   */
  const unfinished = openInterviewEntries(state).unapplied;
  if (unfinished.length) {
    throw new PlangonautError(
      `${unfinished[0].id} has a recorded answer and no recorded consequences. Settle it first: plangonaut qa-settle --project-root . --id ${unfinished[0].id} --interpretation "..." --reply "..." --owner <owner> --operation-id <id>. Nothing was written.`
    );
  }
  assertKnownOwner(state, required(flags, "owner"));
  const at = now();
  const log = ensureInterviewLog(state, at);
  const id = normalizeQuestionId(required(flags, "id"));
  const clash = findInterviewEntry(state, id);
  if (clash) throw new PlangonautError(duplicateQuestionRefusal(clash));

  /*
   * `PLANNED`, `ASKED`, `ANSWERED` and settled are four different things, and
   * the engine keeps them four.
   *
   *   PLANNED    written down, intended, not put to anybody.
   *   ASKED      put to the user. `asked_at` records when the agent says so.
   *   ANSWERED   an answer came back and is recorded.
   *   settled    `ANSWERED` with `consequences_recorded_at` -- the answer has
   *              been applied to the records it changes. It is a timestamp and
   *              not a status word on purpose: only the command that applies can
   *              write it, so no caller can declare it.
   *
   * What the engine cannot do is prove the third-party fact behind `ASKED`. It
   * does not see the conversation; it records the agent's own statement of
   * intention and the order things happened in. An earlier revision inferred
   * presentation from a per-turn arithmetic and refused past it. That was wrong
   * twice over: it proved nothing it claimed to prove, and it capped the total
   * size of an interview that is required to be exhaustive. It is gone.
   *
   * Presentation is the skill's: it puts questions in blocks, five by default
   * and as many as the user asks for, and an interview runs as many blocks as
   * the gaps need. See `nextQuestions` for the engine side of a block, which is
   * a default and not a limit.
   */
  const entry = newInterviewEntry(state, entryInputFromFlags(state, flags, id, flags.planned === true), at);
  /*
   * "Reconstructed from durable evidence" was an unverified self-declaration:
   * the flag set a sentence in the document asserting a provenance nothing had
   * seen. It now has to name the evidence, and the evidence has to exist in the
   * project. `asked_at` is left null as well -- stamping `now()` on an entry
   * that describes something that happened earlier fabricates a timestamp and
   * then prints it without qualification.
   */
  if (entry.reconstructed) {
    if (!nonEmpty(entry.reconstructed_from)) {
      throw new PlangonautError(`--reconstructed needs --reconstructed-from <file>: an entry that claims to come from durable evidence has to name it. Nothing was written.`);
    }
    if (!existingFileInside(root, entry.reconstructed_from as string)) {
      throw new PlangonautError(`Reconstruction evidence does not exist inside the project: ${entry.reconstructed_from}. Nothing was written.`);
    }
    entry.asked_at = null;
    entry.status = "PLANNED";
  }
  log.push(entry);
  // Putting a question against a module is the first significant activity on it.
  const startedModule = touchModule(state, entry.module, at);
  const event = beginInterviewEvent(state, "QUESTION_OPENED", key, {
    at,
    question_id: id,
    status: entry.status,
    module: entry.module,
    owner: entry.owner,
    agent: entry.agent,
    question_sha256: sha256(entry.question),
    reconstructed: entry.reconstructed,
    module_started: startedModule,
  });
  event.at = at;
  /*
   * The recorded next action moves with the ledger, or it lies to the next agent.
   *
   * A pilot opened two questions and `resume` then printed, as its highest
   * priority instruction, "Continue the interview from QNA-0001; no next
   * question is recorded yet" -- false, and two paragraphs above the list of the
   * two questions that were in fact open. `qa-ask` wrote the ledger and left
   * `exact_next_action` where it was, and Resume's precedence puts the recorded
   * action above an open question, so the stale field won.
   *
   * A person's sentence is still never replaced: `advanceGeneratedNextAction`
   * decides, and when it declines it says what it would have written.
   */
  const note = advanceGeneratedNextAction(state, openQuestionsSentence(state));
  commitInterview(root, location, state, event);
  console.log(`Recorded ${id} as ${entry.status}.`);
  if (startedModule !== null) console.log(moduleStartedLine(startedModule, state));
  if (note) console.log(note);
}

function qaAnswer(flags: Flags): void {
  const root = resolveProject(required(flags, "project-root"));
  const key = idempotencyKey(flags);
  if (checkIdempotency(root, key)) return console.log(`Idempotent retry: answer already recorded.`);
  const { location, state } = loadState(root);
  assertKnownOwner(state, required(flags, "owner"));
  const at = now();
  ensureInterviewLog(state, at);
  const id = normalizeQuestionId(required(flags, "id"));
  const entry = findInterviewEntry(state, id);
  if (!entry) throw new PlangonautError(`Unknown question: ${id}`);
  if (entry.status === "ANSWERED") throw new PlangonautError(`${id} already carries an answer. Record a correction with qa-supersede so the earlier answer is preserved.`);
  if (!new Set(["PLANNED", "ASKED"]).has(entry.status)) throw new PlangonautError(`${id} is ${entry.status} and cannot be answered.`);
  const answer = textOrFile(flags, "answer", "Answer") as string;
  entry.answer = answer;
  entry.answered_at = at;
  // A question answered without ever being marked asked is still a question that
  // was put to someone; recording the instant keeps the pair ordered.
  if (!entry.asked_at) entry.asked_at = at;
  entry.status = "ANSWERED";
  // An answer counts too: a question may have been reconstructed or planned
  // before this engine learned to mark the module.
  const startedModule = touchModule(state, entry.module, at);
  /*
   * The agent that recorded the answer is a different fact from the agent that
   * asked, and this used to overwrite the second with the first. The document
   * then attributed the question to whoever happened to be there at the end --
   * an assertion about provenance that could simply be false.
   */
  if (nonEmpty(flags.agent)) entry.answered_by_agent = String(flags.agent).trim();
  entry.updated_at = at;
  const event = beginInterviewEvent(state, "QUESTION_ANSWERED", key, {
    at,
    question_id: id,
    owner: String(flags.owner).trim(),
    answer_sha256: sha256(answer),
    answered_at: at,
    module_started: startedModule,
  });
  event.at = at;
  commitInterview(root, location, state, event);
  console.log(`Recorded the answer to ${id}. It is not applied yet: run qa-settle to record what it changed.`);
  if (startedModule !== null) console.log(moduleStartedLine(startedModule, state));
}

function qaSettle(flags: Flags): void {
  const root = resolveProject(required(flags, "project-root"));
  const key = idempotencyKey(flags);
  if (checkIdempotency(root, key)) return console.log(`Idempotent retry: interaction already settled.`);
  const { location, state } = loadState(root);
  assertKnownOwner(state, required(flags, "owner"));
  const at = now();
  const log = ensureInterviewLog(state, at);
  const id = normalizeQuestionId(required(flags, "id"));
  const entry = findInterviewEntry(state, id);
  if (!entry) throw new PlangonautError(`Unknown question: ${id}`);
  if (entry.status !== "ANSWERED") throw new PlangonautError(`${id} is ${entry.status}; there is no answer to apply.`);
  if (entry.consequences_recorded_at) throw new PlangonautError(`${id} was already settled at ${entry.consequences_recorded_at}. Record a correction with qa-supersede.`);

  const consequences = listFlag(flags, "consequences");
  const records = knownRecordIds(state);
  const unknown = consequences.filter((value) => !records.has(value));
  if (unknown.length) throw new PlangonautError(`These consequences are not records in this project: ${unknown.join(", ")}. Record them first; nothing was written.`);

  /*
   * And it has to be a record this answer actually touched.
   *
   * The document prints these under "Records created or changed". Only the id
   * was checked, so a decision recorded *before* the question was even asked
   * could be listed there, and the document then presented a pre-existing
   * decision as the product of the interaction -- the mirror image of the
   * inference SKILL.md forbids. A record the answer created or changed has an
   * `updated_at` at or after the moment the question was put.
   */
  const askedAt = entry.asked_at ?? entry.created_at;
  const stale = consequences.filter((id) => {
    const record = recordById(state, id);
    const updated = record?.updated_at;
    return typeof updated === "string" && updated < askedAt;
  });
  if (stale.length) {
    throw new PlangonautError(
      `These records were last changed before ${entry.id} was asked, so this answer did not create or change them: ${stale.join(", ")}. Record the change first, or leave them out — the history says "created or changed" and must mean it. Nothing was written.`
    );
  }

  const documents = listFlag(flags, "documents").map((value) => canonicalRelative(value));
  for (const document of documents) {
    if (!existingFileInside(root, document)) throw new PlangonautError(`Document does not exist inside the project: ${document}`);
  }

  entry.interpretation = textOrFile(flags, "interpretation", "Interpretation") as string;
  entry.reply = textOrFile(flags, "reply", "Reply to the user") as string;
  entry.consequences = consequences;
  entry.documents = documents;
  entry.open_points = listFlag(flags, "open-points");
  /*
   * The next question is opened here, in this transaction, or not at all.
   *
   * A pointer to a question that does not exist yet is a dangling reference, and
   * the validator refuses one -- correctly: the first run of this code proposed
   * `QNA-0002` and the engine rejected the whole settlement. Recording the
   * proposal and opening the entry as two steps would reintroduce exactly the
   * half-finished state this ledger exists to make impossible, so `qa-settle`
   * does both or neither.
   */
  entry.next_question = textOrFile(flags, "next-question", "Next question", true);
  entry.next_id = nonEmpty(flags["next-id"]) ? normalizeQuestionId(String(flags["next-id"])) : null;
  if (entry.next_id && !findInterviewEntry(state, entry.next_id)) {
    if (!nonEmpty(entry.next_question)) {
      throw new PlangonautError(`--next-id ${entry.next_id} is not in the ledger. Supply --next-question so it can be opened, or name a question that already exists.`);
    }
    log.push(
      newInterviewEntry(
        state,
        {
          id: entry.next_id,
          question: entry.next_question as string,
          // Derived from what just happened, not invented: this entry exists
          // because settling the previous one proposed it.
          rationale: nonEmpty(flags["next-rationale"])
            ? String(flags["next-rationale"]).trim()
            : `Proposed by ${entry.id} when its answer was settled.`,
          /*
           * The follow-up inherits the module of the question that proposed it,
           * including its crosscutting status: a question raised by a
           * crosscutting one is on the same detour, and pretending otherwise
           * would make the deviation disappear after a single turn.
           */
          module: moduleFlag(state, flags["next-module"] ?? entry.module),
          crosscutting: entry.crosscutting === true,
          crosscuttingReason: entry.crosscutting === true ? (entry.crosscutting_reason ?? null) : null,
          agent: entry.agent,
          owner: String(flags.owner).trim(),
          planned: true,
          reconstructed: false,
          reconstructedFrom: null,
        },
        at
      )
    );
  }
  entry.consequences_recorded_at = at;
  const startedModule = touchModule(state, entry.module, at);
  entry.updated_at = at;

  /*
   * Settling moves the project on, so it moves the recorded next action on.
   *
   * It did not, and the consequence was the loudest thing the review found: the
   * frontier ranks the exact next action third, so every project driven by this
   * ledger kept printing `init`'s placeholder -- "discuss module 1" -- above the
   * interview it was actually in. An agent obeying the bold line would do the
   * one thing SKILL.md forbids.
   *
   * `advanceGeneratedNextAction` is the existing rule and is used unchanged: a
   * sentence a person wrote is kept and the suggestion is reported instead.
   */
  /*
   * The answer that finishes a module closes it here, in the same transaction.
   *
   * A module takes several questions, so nothing advances it automatically: the
   * agent says when the module is done, with the same three things `record`
   * needs — an outcome, the evidence file, the owner. It calls
   * `applyModuleOutcome`, which is the code `record` calls, so the rules are not
   * duplicated and cannot drift. Doing it in one transaction is the point: the
   * settlement and the module outcome are one fact about the interview, and an
   * interruption between two commands is how a module stays open under an
   * answer that finished it.
   */
  let moduleNote: string | null = null;
  let completedModule: { id: number; status: string } | null = null;
  const wantsModule = nonEmpty(flags["complete-module"]);
  if (wantsModule || nonEmpty(flags["module-answer-file"])) {
    if (!wantsModule || !nonEmpty(flags["module-answer-file"])) {
      throw new PlangonautError(`--complete-module and --module-answer-file go together: a module outcome without its recorded evidence is not a record. Nothing was written.`);
    }
    if (entry.module === null || entry.module === undefined) {
      throw new PlangonautError(`${entry.id} is not recorded against any module, so settling it cannot complete one. Nothing was written.`);
    }
    if (entry.crosscutting === true) {
      throw new PlangonautError(
        `${entry.id} is a crosscutting question (module ${entry.module}: ${entry.crosscutting_reason ?? "no reason recorded"}). ` +
          `A detour does not close the module it detoured into. Record that module with \`plangonaut record\` when its own questions are done. Nothing was written.`,
      );
    }
    const applied = applyModuleOutcome(
      root,
      state,
      {
        moduleId: entry.module,
        status: String(flags["complete-module"]),
        answerFile: String(flags["module-answer-file"]),
        owner: String(flags.owner).trim(),
        summary: flags["module-summary"],
      },
      at,
    );
    completedModule = { id: entry.module, status: applied.outcome };
    moduleNote = applied.nextActionNote;
  }

  /*
   * The sentence is read off the ledger, not off this one entry.
   *
   * It used to look only at `entry.next_id`, so settling a question while three
   * others were open announced "no next question is recorded yet" — and `resume`
   * printed that at the top and listed the three fifty lines below. The
   * follow-up this settlement opens is still named when there is one, because
   * that is the more useful sentence; everything else comes from the log.
   */
  const nextActionNote = completedModule
    ? moduleNote
    : advanceGeneratedNextAction(
        state,
        entry.next_id
          ? generatedSentence(`Ask ${entry.next_id}: ${entry.next_question ?? findInterviewEntry(state, entry.next_id)?.question ?? "the recorded next question"}`)
          : openQuestionsSentence(state),
      );

  const event = beginInterviewEvent(state, "QUESTION_SETTLED", key, {
    at,
    question_id: id,
    owner: String(flags.owner).trim(),
    consequences,
    documents,
    open_points: entry.open_points,
    next_id: entry.next_id,
    module_completed: completedModule,
    module_started: startedModule,
  });
  event.at = at;
  commitInterview(root, location, state, event);
  console.log(`Settled ${id}: ${consequences.length} record(s), ${documents.length} document(s).`);
  if (startedModule !== null) console.log(moduleStartedLine(startedModule, state));
  if (completedModule) console.log(`Recorded module ${completedModule.id} as ${completedModule.status} in the same operation.`);
  if (entry.open_points.length) console.log(`${entry.open_points.length} point(s) still open on this answer.`);
  if (nextActionNote) console.log(`${NL}${nextActionNotice(root, nextActionNote)}`);
}

function qaClose(flags: Flags): void {
  const root = resolveProject(required(flags, "project-root"));
  const key = idempotencyKey(flags);
  if (checkIdempotency(root, key)) return console.log(`Idempotent retry: question already closed.`);
  const { location, state } = loadState(root);
  assertKnownOwner(state, required(flags, "owner"));
  const at = now();
  ensureInterviewLog(state, at);
  const kind = String(required(flags, "kind")).toLowerCase();
  if (!QA_CLOSE_KINDS.has(kind)) throw new PlangonautError(`--kind must be one of ${[...QA_CLOSE_KINDS].join(", ")}`);
  const id = normalizeQuestionId(required(flags, "id"));
  const entry = findInterviewEntry(state, id);
  if (!entry) throw new PlangonautError(`Unknown question: ${id}`);
  if (new Set(["SUPERSEDED", "DEFERRED", "SKIPPED", "INVALIDATED"]).has(entry.status)) throw new PlangonautError(`${id} is already ${entry.status}.`);
  if (kind !== "invalidated" && entry.status === "ANSWERED") throw new PlangonautError(`${id} has an answer; it cannot be ${kind}. Use --kind invalidated if the answer no longer holds.`);
  const reason = textOrFile(flags, "reason", "Reason") as string;
  entry.status = kind.toUpperCase();
  entry.closed_reason = reason;
  entry.updated_at = at;
  const event = beginInterviewEvent(state, "QUESTION_CLOSED", key, {
    at,
    question_id: id,
    status: entry.status,
    owner: String(flags.owner).trim(),
    reason_sha256: sha256(reason),
  });
  event.at = at;
  // Closing a question changes what the interview is waiting for, and the
  // recorded action has to follow: it used to keep naming a question that
  // `qa-answer` then refuses as DEFERRED.
  const closedNote = advanceGeneratedNextAction(state, openQuestionsSentence(state));
  commitInterview(root, location, state, event);
  console.log(`${id} is now ${entry.status}.`);
  if (closedNote) console.log(nextActionNotice(root, closedNote));
}

function qaSupersede(flags: Flags): void {
  const root = resolveProject(required(flags, "project-root"));
  const key = idempotencyKey(flags);
  if (checkIdempotency(root, key)) return console.log(`Idempotent retry: replacement already recorded.`);
  const { location, state } = loadState(root);
  /*
   * The same two guards `qa-ask` applies, because this opens a question too.
   *
   * It did not, and an independent review walked through the hole: with an
   * unsettled answer, `qa-ask` refuses and `qa-supersede` opened a new ASKED
   * entry anyway -- and because the superseded entry leaves `status: ANSWERED`,
   * the unsettled answer dropped out of `openInterviewEntries` and Resume
   * stopped reporting it. The same route bypassed an unreconciled override.
   */
  assertNotBlocked(state);
  assertKnownOwner(state, required(flags, "owner"));
  const at = now();
  const log = ensureInterviewLog(state, at);
  const unsettled = openInterviewEntries(state).unapplied;
  if (unsettled.length) {
    throw new PlangonautError(
      `${unsettled[0].id} has a recorded answer and no recorded consequences. Settle it before replacing any question: a superseded entry stops being reported as open, so this would hide the unfinished work rather than finish it. Nothing was written.`
    );
  }
  const oldId = normalizeQuestionId(required(flags, "id"));
  const newId = normalizeQuestionId(required(flags, "new-id"));
  if (oldId === newId) throw new PlangonautError(`A question cannot supersede itself.`);
  const previous = findInterviewEntry(state, oldId);
  if (!previous) throw new PlangonautError(`Unknown question: ${oldId}`);
  if (previous.status === "SUPERSEDED") throw new PlangonautError(`${oldId} was already superseded by ${previous.superseded_by}.`);
  if (findInterviewEntry(state, newId)) throw new PlangonautError(`${newId} already exists.`);
  const reason = textOrFile(flags, "reason", "Reason") as string;

  // The replacement is a new entry. The old one keeps its question, its answer
  // and its consequences, and gains only the pointer: a correction that erased
  // what it corrected would be a correction nobody could audit.
  const replacement = newInterviewEntry(state, entryInputFromFlags(state, flags, newId, false), at);
  replacement.supersedes = oldId;
  previous.status = "SUPERSEDED";
  previous.superseded_by = newId;
  previous.closed_reason = reason;
  previous.updated_at = at;
  log.push(replacement);

  const event = beginInterviewEvent(state, "QUESTION_SUPERSEDED", key, {
    at,
    question_id: oldId,
    replaced_by: newId,
    owner: String(flags.owner).trim(),
    reason_sha256: sha256(reason),
    question_sha256: sha256(replacement.question),
  });
  event.at = at;
  // Same reason as `qa-close`: the replacement is what is open now, and the
  // recorded action named the question it replaced.
  const supersededNote = advanceGeneratedNextAction(state, openQuestionsSentence(state));
  commitInterview(root, location, state, event);
  console.log(`${oldId} is SUPERSEDED by ${newId}; both remain in the history.`);
  if (supersededNote) console.log(nextActionNotice(root, supersededNote));
}

function qaLog(flags: Flags): void {
  const root = resolveProject(required(flags, "project-root"));
  const { state } = loadState(root);
  const entries = interviewLog(state);

  if (flags.regenerate === true) {
    const rendered = renderInterviewView(state);
    const digest = sha256(rendered);
    const recorded = state.interview_view?.sha256 ?? null;
    writeInterviewView(root, rendered);
    if (recorded && recorded !== digest) {
      console.log(`Regenerated ${QA_VIEW_RELATIVE}. The digest recorded in state (${recorded.slice(0, 12)}) does not match what this state renders (${digest.slice(0, 12)}): the state was changed by something other than a qa command. Run plangonaut validate.`);
      return;
    }
    console.log(`Regenerated ${QA_VIEW_RELATIVE} from the ledger.`);
    return;
  }

  if (nonEmpty(flags.id)) {
    const entry = findInterviewEntry(state, normalizeQuestionId(String(flags.id)));
    if (!entry) throw new PlangonautError(`Unknown question: ${flags.id}`);
    console.log(JSON.stringify(entry, null, 2));
    return;
  }

  const open = openInterviewEntries(state);
  if (flags.json === true) {
    console.log(JSON.stringify({
      recorded_since: state.interview_log_since ?? null,
      entries: entries.length,
      last: entries.at(-1) ?? null,
      open_asked: open.asked.map((entry) => entry.id),
      open_planned: open.planned.map((entry) => entry.id),
      answered_not_applied: open.unapplied.map((entry) => entry.id),
    }, null, 2));
    return;
  }

  if (flags.last === true) {
    const last = entries.at(-1);
    console.log(last ? JSON.stringify(last, null, 2) : "No interaction is recorded for this project.");
    return;
  }

  if (flags.open === true) {
    if (!open.asked.length && !open.unapplied.length && !open.planned.length) {
      console.log("Nothing open: every recorded question is answered and applied.");
      return;
    }
    for (const entry of open.asked) console.log(`ASKED, no answer      ${entry.id}  ${entry.question}`);
    for (const entry of open.unapplied) console.log(`ANSWERED, not applied ${entry.id}  ${entry.question}`);
    for (const entry of open.planned) console.log(`PLANNED, not asked    ${entry.id}  ${entry.question}`);
    return;
  }

  console.log(renderInterviewView(state));
}

/**
 * What Resume prints about the interview, and the frontier it computes from it.
 *
 * The order below is the recorded precedence and is not a heuristic: integrity
 * and reconciliation first, then a human override, then the exact next action a
 * person wrote, then the gate, then a question actually recorded as open, then
 * open decisions, and only then the questionnaire catalog. The catalog is last
 * because restarting the interview over a project that already has a state is
 * the failure this whole ledger exists to prevent.
 */
function interviewMarkdown(state: any): string[] {
  const entries = interviewLog(state);
  const open = openInterviewEntries(state);
  /*
   * Completed means the answer was applied, not that the entry is still current.
   *
   * This filtered on `status === "ANSWERED"` and reported "no interaction has
   * been completed" on a project whose first question had been asked, answered,
   * settled and then superseded by a correction. Every one of those steps
   * happened; the entry simply is not the current one any more. A superseded
   * entry is history, and history is what this section is.
   */
  const settled = entries.filter((entry) => nonEmpty(entry.consequences_recorded_at));
  const last = settled.at(-1) ?? null;
  const lines = ["## Interview history", ""];

  if (!Array.isArray(state.interview_log)) {
    lines.push(
      "- This project predates the interview ledger. No question or answer was recorded, which is not the same as no question having been asked.",
      "- Start recording with `plangonaut qa-ask`; earlier interactions are not reconstructed.",
      ""
    );
    return lines;
  }

  lines.push(`- Recorded interactions: ${entries.length} (history available since ${state.interview_log_since ?? "not recorded"})`);
  lines.push(`- Readable at: ${QA_VIEW_RELATIVE}`);
  /*
   * A question asked outside the active module is a deviation, and Resume says
   * so. Both ALN-011 pilots found questions on module 2 while the active module
   * was 1 and reported that the folder did not explain it; the engine refuses
   * that silently-created state now, and where a deviation is deliberate it is
   * named here rather than left for a reader to notice.
   */
  const active = activeModule(state);
  const detours = entries.filter((entry: any) => entry.crosscutting === true && !QA_CLOSE_KINDS.has(String(entry.status).toLowerCase()) && entry.status !== "SUPERSEDED");
  if (detours.length) {
    lines.push(
      `- ${detours.length} question${detours.length === 1 ? " was" : "s were"} asked outside the module the interview is on${active ? ` (module ${active.id} — ${active.title})` : ""}. They do not mean the earlier modules are finished:`,
    );
    for (const entry of detours) {
      lines.push(`  - ${entry.id} on module ${entry.module}: ${entry.crosscutting_reason ?? "no reason recorded"}`);
    }
  }
  lines.push(
    last
      ? `- Last completed interaction: ${last.id}${last.status === "SUPERSEDED" ? ` (since superseded by ${last.superseded_by})` : ""} — ${last.question}`
      : "- Last completed interaction: none; no answer has been applied yet."
  );
  if (last) {
    lines.push(`  - Module: ${last.module ?? "not recorded"}`);
    lines.push(`  - Records changed: ${(last.consequences ?? []).length ? last.consequences.join(", ") : "none recorded"}`);
    lines.push(`  - Documents changed: ${(last.documents ?? []).length ? last.documents.join(", ") : "none recorded"}`);
  }

  /*
   * Points recorded as still open, from any settled answer.
   *
   * They were written into the document and nowhere else, so `resume` -- the one
   * thing a fresh agent is told to read -- never mentioned them. An ambiguity
   * recorded and never surfaced is an ambiguity nobody resolves.
   */
  const outstanding = entries.flatMap((item) =>
    (item.open_points ?? []).map((point) => `  - ${item.id}: ${point}`)
  );
  if (outstanding.length) {
    lines.push("- Points recorded as still open:");
    lines.push(...outstanding);
  }
  for (const entry of open.asked) lines.push(`- **Asked and unanswered:** ${entry.id} — ${entry.question}`);
  for (const entry of open.unapplied) lines.push(`- **Answered and not applied:** ${entry.id} — the answer is recorded and its consequences are not. Settle it with \`plangonaut qa-settle\` before asking anything else.`);
  for (const entry of open.planned) lines.push(`- Planned, not asked: ${entry.id} — ${entry.question}`);
  if (!open.asked.length && !open.unapplied.length && !open.planned.length) lines.push("- Nothing open in the interview.");

  const conflicts: string[] = [];
  if (open.unapplied.length && state.needs_reconciliation) conflicts.push("an answer is unapplied while a human override is open; reconcile first, then settle.");
  for (const entry of settled) {
    for (const consequence of entry.consequences ?? []) {
      if (!knownRecordIds(state).has(consequence)) conflicts.push(`${entry.id} names ${consequence}, which is no longer a record in this project.`);
    }
  }
  if (conflicts.length) {
    lines.push("", "### Conflicts between the history and the project", "");
    for (const conflict of conflicts) lines.push(`- ${conflict}`);
  }
  lines.push("");
  return lines;
}

function resumeFrontier(state: any): string[] {
  const open = openInterviewEntries(state);
  const openOverride = (state.human_overrides ?? []).find((item: any) => item.status === "OPEN");
  const openDecisions = (state.decisions ?? []).filter((item: any) => item.status === "PROPOSED" || item.status === "DRAFT");

  /*
   * The recorded precedence, in its recorded order.
   *
   * An unfinished settlement is deliberately **not** one of these ranks. It is a
   * precondition printed above them: the rule is "complete that transaction
   * before asking a new question", not "do it before everything else". The first
   * version of this function ranked it third, above the exact next action, and a
   * fresh agent reading the output noticed the difference — correctly. The two
   * statements are not the same, and the one written down is this one.
   */
  const candidates: { rank: number; line: string }[] = [];
  if (state.needs_reconciliation) candidates.push({ rank: 1, line: `Reconcile ${openOverride?.id ?? "the open human override"} before any other work.` });
  else if (openOverride) candidates.push({ rank: 2, line: `Apply the recorded human override ${openOverride.id}.` });
  if (nonEmpty(state.exact_next_action)) candidates.push({ rank: 3, line: `Exact next action, as recorded: ${state.exact_next_action}` });
  candidates.push({ rank: 4, line: `Current position: ${state.lifecycle_state}, gate ${state.current_gate}.` });
  if (open.asked.length) candidates.push({ rank: 5, line: `Put ${open.asked[0].id} to the user again, with its context. It was asked and never answered; do not treat it as answered.` });
  if (open.planned.length) candidates.push({ rank: 5.5, line: `Ask ${open.planned[0].id}, which is recorded as planned.` });
  if (openDecisions.length) candidates.push({ rank: 6, line: `Close the open decisions: ${openDecisions.map((item: any) => item.id).join(", ")}.` });
  candidates.sort((left, right) => left.rank - right.rank);

  const lines = ["## Where to continue", ""];

  if (open.unapplied.length) {
    lines.push(
      `**First, finish what is open.** ${open.unapplied[0].id} has a recorded answer and no recorded consequences. Settle it with \`plangonaut qa-settle\` before putting any new question to the user: until then the interview has an unfinished transaction, and \`qa-ask\` will refuse.`,
      ""
    );
  }

  if (!candidates.length) {
    lines.push("- Nothing is recorded as outstanding. Read the canonical documents before concluding the project is complete.", "");
    return lines;
  }
  lines.push(`**Start here.** ${candidates[0].line}`, "");
  if (candidates.length > 1) {
    lines.push("Then, in this order:", "");
    for (const candidate of candidates.slice(1)) lines.push(`- ${candidate.line}`);
    lines.push("");
  }
  lines.push(
    "The questionnaire catalog below is last in this order on purpose: a project that has a state does not restart its interview.",
    ""
  );
  return lines;
}

/**
 * The three states and the standing of every recorded read, for `resume`.
 *
 * `resume` is what an agent reads when it picks a folder up cold, which makes
 * it the one place where "somebody said they read this" has to be separated
 * from "this was read, and here is the proof".
 */
function resumeReadinessLines(root: string, state: State): string[] {
  const readiness = readinessReport(state, root);
  const lines = [``, `## Completeness`, ``, ...readinessLines(readiness, "NOT ASSESSED").slice(0, 2)];
  if (readiness.intent === "NO") {
    lines.push(``, `Definition complete.`, `Execution readiness not requested.`, `This folder is not an execution package.`);
  } else if (readiness.execution.verdict === "FAILED") {
    lines.push(``, `Execution readiness fails on:`);
    for (const finding of readiness.execution.findings.slice(0, 6)) lines.push(`- ${finding}`);
    if (readiness.execution.findings.length > 6) lines.push(`- … and ${readiness.execution.findings.length - 6} more.`);
  } else if (readiness.execution.verdict === "NOT ASSESSED") {
    lines.push(``, ...readiness.execution.remedy.map((line) => `- ${line}`));
  }

  const reads = readStandings(root, state);
  lines.push(``, `## Files this project was built on`, ``);
  if (!reads.length) {
    lines.push(
      `No read is recorded. That is an absence of evidence, not a statement that nothing was read:`,
      `a claim in an earlier turn that a file was read is not evidence, and neither is a later claim that it was not.`,
      `Record one with plangonaut read-record --project-root . --path <file> --purpose "<why>" --owner <owner> --operation-id <id>.`,
    );
  } else {
    for (const entry of reads) {
      const label =
        entry.standing === "PROVED" ? "read and proved"
        : entry.standing === "CHANGED SINCE" ? "**changed since it was read**"
        : "**no longer in the folder**";
      lines.push(`- ${entry.record.path} — ${label} (${entry.record.agent}, ${entry.record.purpose})`);
      if (entry.standing === "CHANGED SINCE" && (entry.record.used_by ?? []).length) {
        lines.push(`  ${(entry.record.used_by ?? []).join(", ")} rest on the earlier reading.`);
      }
    }
    const cited = citedButUnverified(state, reads);
    for (const line of cited) lines.push(`- ${line}`);
  }
  return lines;
}

/**
 * Files a governed document points at that nobody recorded reading.
 *
 * The fourth standing, and the one that is easiest to miss: a document can rest
 * on a file, name it, and nothing anywhere says anybody opened it.
 */
function citedButUnverified(state: State, reads: { record: ReadRecord }[]): string[] {
  const proven = new Set(reads.map((entry) => entry.record.path));
  const lines: string[] = [];
  for (const artifact of state.artifacts ?? []) {
    const value = nonEmpty(artifact.working_path) ? artifact.working_path : artifact.base_path;
    if (!nonEmpty(value)) continue;
    const relative = canonicalRelative(String(value));
    if (proven.has(relative)) continue;
    lines.push(`${relative} — cited by ${artifact.id}, no read recorded`);
  }
  return lines.slice(0, 10);
}

function resume(flags: Flags): void {
  const root = resolveProject(required(flags, "project-root"));
  /*
   * The order is the contract, and it is this one:
   *
   *   1. finish or undo an interrupted write   (`validateRoot` -> `loadState`)
   *   2. verify the event chain and the replay (`historyErrors`)
   *   3. stop if the state and its history disagree
   *   4. regenerate derived views, but only once the canonical source is intact
   *   5. only then, say where to continue
   *
   * Putting step 5 before steps 1-3 is how an agent ends up working confidently
   * on a project that was interrupted mid-write, which is the situation this
   * whole mechanism exists for.
   */
  const state = validateRoot(root);
  const history = historyErrors(root, state);
  const recovered = recoveredInThisRun.slice();
  if (history.errors.length) {
    console.log(`# Resume blocked\n\nThe durable state and the history that produced it do not agree, so nothing here can be trusted as the project's position.\n\n- ${history.errors.join("\n- ")}\n\nNothing was changed. Resolve this before answering any question or writing any file.`);
    // And it exits non-zero. It used to print that and return 0, so a caller
    // checking the exit code saw success on the one output that says the project
    // cannot be trusted — `validate` has always exited 2 on the same condition.
    throw new PlangonautError("Resume is blocked: the state does not agree with its history. The report above says which fields, and how to rebuild them.");
  }
  const regenerated = regenerateDerivedViews(root);
  if (state.needs_reconciliation) {
    console.log(`${contextMarkdown(state)}\n## Resume blocked\n\nReconcile the open human override before continuing normal work.`);
    // Non-zero, for the same reason the divergence branch is: a caller checking
    // the status code must not see success on an output whose heading is
    // "Resume blocked". The second review found this branch still returning 0
    // after the other one had been fixed.
    throw new PlangonautError("Resume is blocked: an open human override has to be reconciled before normal work continues. The report above says which.");
  }
  // The heading used to read "Resume questions", and a fresh recipient in the
  // ALN-005 handoff test took it as an instruction: it went to interview the user
  // about the active module while the dossier said the interview was over and the
  // remaining work was a physical survey a conversation cannot produce. The
  // recorded exact next action is the authority; these are catalog prompts, and
  // the heading now says which is which.
  const integrity: string[] = [];
  /*
   * Above everything a reader treats as a plan, and deliberately so: this
   * is the one thing on the page that says the plan below rests on
   * something the project itself contradicts.
   */
  const holdFindings = advanceHold(root, state);
  if (holdFindings.length) {
    integrity.push("## Resolve this before continuing", "");
    for (const line of advanceHoldLines(holdFindings)) integrity.push(line.startsWith("- ") ? line : `${line}`);
    integrity.push("");
  }
  if (recovered.length) {
    integrity.push("## An interrupted operation was recovered", "", "The last run of Plangonaut on this project did not finish. It has been resolved before anything below was read:", "");
    for (const line of recovered) integrity.push(`- ${line}`);
    integrity.push("");
  }
  const stagings = outstandingStagings(root).filter((item) => item.present);
  if (stagings.length) {
    integrity.push("## An export did not finish", "");
    for (const item of stagings) {
      integrity.push(`- a package for \`${item.note.destination}\` was left at phase ${item.note.phase}, started ${item.note.created_at}${item.alive ? " by a process that is still running" : ""}.`);
    }
    integrity.push("", "Nothing in the project changed: an export only ever reads it. Run `plangonaut recover --project-root . --apply` to clear what is left beside the destination, then export again.", "");
  }
  if (regenerated.length) {
    integrity.push("## A derived view was regenerated", "", `${regenerated.join("; ")}. The canonical state was intact, so the document was rebuilt from it rather than the other way round.`, "");
  }
  if (history.notes.length) {
    integrity.push("## What the history can and cannot prove", "", ...history.notes.map((note) => `- ${note}`), "");
  }
  console.log(`${contextMarkdown(state)}\n${integrity.join("\n")}\n${resumeReadinessLines(root, state).join("\n")}\n${interviewMarkdown(state).join("\n")}\n${resumeFrontier(state).join("\n")}\n## Catalog questions for the active module\n\nThese come from the questionnaire catalog, not from this project. The recorded exact next action above prevails; ask these only if the module is genuinely still open and an answer would change the outcome.\n\n${nextQuestions(state).trimEnd()}\n\nRe-verify canonical sources before changing files.`);
}

/**
 * Record a module outcome on a state already in hand.
 *
 * Extracted from `record` so that `qa-settle --complete-module` can close a
 * module in the same transaction as the answer that closed it, without a second
 * copy of the rules. Both callers validate the status against `MODULE_STATUSES`,
 * both confine the evidence inside the project, both refuse an empty file, and
 * both advance the engine's own next action while keeping a person's.
 *
 * It returns what the caller has to put in its event, and mutates nothing else.
 */
function applyModuleOutcome(
  root: string,
  state: State,
  input: { moduleId: number; status: string; answerFile: string; owner: string; summary?: unknown },
  at: string,
): { module: Module; outcome: string; nextActionNote: string | null; confirmationBlockers: string[] } {
  const outcome = input.status.toUpperCase().replaceAll("_", " ");
  if (!MODULE_STATUSES.has(outcome)) throw new PlangonautError(`Unsupported module status: ${outcome}`);
  const sourcePath = path.resolve(input.answerFile);
  const answerRelative = path.relative(root, sourcePath);
  const answerRefusal = artifactPathRefusal("Answer evidence", answerRelative);
  if (answerRefusal) throw new PlangonautError(answerRefusal);
  const confinedAnswer = existingFileInside(root, answerRelative);
  if (!confinedAnswer) throw new PlangonautError(`Answer evidence must be an existing file inside the project root`);
  const bytes = fs.readFileSync(confinedAnswer);
  if (!bytes.length || !bytes.toString("utf8").trim()) throw new PlangonautError(`Answer evidence cannot be empty: ${sourcePath}`);
  const module = state.modules.find((item) => item.id === input.moduleId);
  if (!module) throw new PlangonautError(`Unknown module: ${input.moduleId}`);

  /*
   * The same layering as an approval's provenance, and for the same measured
   * reason. See the note in `ledgerMutation`.
   *
   * Refusing the write broke 22 call sites that use `CONFIRMED` to set a module
   * terminal while testing something else, and compatibility with what exists
   * was a requirement. So the write says what it sees; `validate` reports it;
   * `handoff-check` blocks on it, which is the moment that matters -- a folder
   * does not get handed over with a module confirmed over its own open
   * questions.
   *
   * The brief allowed either: "a check or a warning, where possible."
   */
  /*
   * Refused before anything is written, for the three operational modules.
   *
   * `confirmationBlockers` below warns; these refuse. The difference is what
   * the label is load-bearing for: a confirmed module 9 is a statement that the
   * architecture was discussed, and a confirmed module 16 is a statement that
   * the project is ready, which the pilot made and was not.
   */
  const refusals = operationalModuleRefusals(root, state, input.moduleId, outcome);
  if (refusals.length) {
    throw new PlangonautError(
      `Module ${input.moduleId} cannot be recorded ${outcome}:\n- ${refusals.join("\n- ")}\n` +
        `Nothing was written. These are about what the project holds, not about whether the questions were asked.`,
      "PROJECT_STATE_UNTRUSTED",
    );
  }
  const confirmationBlockers = outcome === "CONFIRMED" ? moduleConfirmationBlockers(state, input.moduleId) : [];
  Object.assign(module, {
    status: outcome,
    owner: input.owner,
    evidence: canonicalRelative(path.relative(root, sourcePath)) || path.basename(sourcePath),
    evidence_sha256: sha256(bytes),
    summary: input.summary && typeof input.summary === "string" ? input.summary.trim().slice(0, 240) : null,
    updated_at: at,
  });
  const active = activeModule(state);
  /*
   * The recorded action does not step over the project's own contradictions.
   *
   * Written after `record --status CONFIRMED`, this is the sentence a fresh
   * recipient is told to obey. Offering the next module while the module just
   * confirmed disagrees with its own ledger is how a folder comes to read as
   * settled -- and a person's recorded sentence is still never overwritten, which
   * `advanceGeneratedNextAction` decides, not this.
   */
  // The same list `next`, `resume` and `status` show, so one session never
  // reports two different counts of the same contradictions.
  const hold = advanceHold(root, state);
  const nextActionNote = advanceGeneratedNextAction(
    state,
    hold.length
      ? advanceHoldAction(hold.length)
      : active ? `Discuss module ${active.id} — ${active.title}.` : "Review coverage, then proceed to G2.",
  );
  return { module, outcome, nextActionNote, confirmationBlockers };
}

function record(flags: Flags): void {
  const root = resolveProject(required(flags, "project-root"));
  const key = idempotencyKey(flags);
  if (checkIdempotency(root, key)) return console.log(`Idempotent retry: record already applied.`);
  const { location, state } = loadState(root);
  assertNotBlocked(state);
  assertKnownOwner(state, required(flags, "owner"));
  const moduleId = Number(required(flags, "module"));
  const timestamp = now();
  // `/`, always: `path.relative` hands back `ans\m1.md` on Windows, and that is a
  // file name rather than a path on the POSIX machine the folder is handed to.
  // Recording a module advances the interview, so it proposes the next module to
  // discuss — over its own sentence only. A next action a person wrote is kept
  // and the suggestion reported instead, because that field is what a fresh
  // recipient is told to obey and the recipient reads the folder, not this
  // terminal.
  const { module, outcome, nextActionNote, confirmationBlockers } = applyModuleOutcome(
    root,
    state,
    { moduleId, status: required(flags, "status"), answerFile: required(flags, "answer-file"), owner: String(flags.owner), summary: flags.summary },
    timestamp,
  );
  state.updated_at = timestamp;
  const revision = state.revision + 1;
  const eventId = crypto.randomUUID();
  state.revision = revision;
  state.last_event_id = eventId;
  const event = { event_id: eventId, type: "MODULE_RECORDED", state_revision: revision, at: timestamp, idempotency_key: key, module: moduleId, status: outcome, owner: flags.owner, evidence: module.evidence, evidence_sha256: module.evidence_sha256 };
  commitState(root, location, state, event);
  console.log(`Recorded module ${moduleId} as ${outcome}`);
  if (confirmationBlockers.length) {
    console.log(
      `\nWARNING: module ${moduleId} is now CONFIRMED, and ${confirmationBlockers.length} thing${confirmationBlockers.length === 1 ? "" : "s"} in its own ledger say${confirmationBlockers.length === 1 ? "s" : ""} otherwise:\n` +
      confirmationBlockers.map((line) => `- ${line}`).join("\n") +
      `\nCONFIRMED means the project may build on this module. plangonaut handoff-check refuses to hand the folder over like this; ` +
      `if a concern here does not apply, NOT_APPLICABLE or DEFERRED say so honestly.`
    );
  }
  if (nextActionNote) console.log(`\n${nextActionNotice(root, nextActionNote)}`);
}

function override(flags: Flags): void {
  const root = resolveProject(required(flags, "project-root"));
  const key = idempotencyKey(flags);
  if (checkIdempotency(root, key)) return console.log(`Idempotent retry: override already applied.`);
  const { location, state } = loadState(root);
  assertKnownOwner(state, required(flags, "owner"));
  // The instruction file is the override's own text, and the ledger records the
  // path to it. It therefore obeys the same rule as every other travelling
  // record — see `recordedSourceFile`, which is now the only place that rule is
  // written down.
  const sourcePath = path.resolve(required(flags, "instruction-file"));
  const source = recordedSourceFile(root, "Override instruction", sourcePath, {
    suffix: "\nNothing was written; no override was recorded.",
  });
  const bytes = fs.readFileSync(source.absolute);
  const timestamp = now();
  const item = { id: `OVR-${crypto.randomBytes(6).toString("hex")}`, status: "OPEN", owner: required(flags, "owner"), reason: typeof flags.reason === 'string' ? flags.reason : "Human direction changed by prompt", source: source.relative, source_sha256: source.hash, summary: bytes.toString("utf8").replace(/\s+/g, " ").slice(0, 240), created_at: timestamp };
  state.human_overrides.push(item);
  state.needs_reconciliation = true;
  // `needs_reconciliation` already carries the block, and `plangonaut next` refuses on
  // it, so the reconciliation requirement does not need this field to be heard.
  // A next action a person wrote does need it, and an override recorded on a
  // folder carrying a handoff instruction used to destroy it without a word.
  const overrideNextActionNote = advanceGeneratedNextAction(
    state,
    `Reconcile ${item.id}: identify impacted decisions, artifacts, tasks, agents, tests, and gates.`
  );
  state.updated_at = timestamp;
  const revision = state.revision + 1;
  const eventId = crypto.randomUUID();
  state.revision = revision;
  state.last_event_id = eventId;
  const event = { event_id: eventId, type: "HUMAN_OVERRIDE_RECORDED", state_revision: revision, at: timestamp, idempotency_key: key, ...item };
  commitState(root, location, state, event);
  console.log(`Recorded human override ${item.id}; downstream work requires reconciliation.`);
  if (overrideNextActionNote) console.log(`
${nextActionNotice(root, overrideNextActionNote)}`);
}

/**
 * Close an open human override, without overwriting a person's next action by default.
 *
 * `reconcile` is the step the engine *orders* after every override — the message
 * `override` prints names this command. It also assigned `--next-action`
 * unconditionally, bypassing `advanceGeneratedNextAction`, which `record`, `gate`
 * and `override` all go through. So the one command a human is told to run next
 * was the one command that destroyed the sentence a human had written, in
 * `state.json` and in `events.jsonl` alike. It survived only in `.beave/backups/`,
 * and backups do not travel in the package.
 *
 * `--next-action` is now optional, which is the root of the fix: it used to be
 * mandatory, so the operator did not replace the sentence because they wanted to,
 * they replaced it because the command left no other way to run. Four outcomes,
 * all of them named in the event:
 *
 *  - `generated`   — nothing human was recorded and none was supplied.
 *  - `preserved`   — a human sentence was recorded and none was supplied: kept.
 *  - `replaced`    — a human sentence was recorded and `--replace-human-next-action`
 *                    was given with a different `--next-action`.
 *  - `blocked_by_open_override` — another override is still open, so the blocker
 *                    sentence wins, as it always has.
 *
 * Supplying a `--next-action` identical to what is already recorded is not a
 * replacement and is not refused: nothing changes.
 */
function reconcile(flags: Flags): void {
  const root = resolveProject(required(flags, "project-root"));
  const key = idempotencyKey(flags);
  if (checkIdempotency(root, key)) return console.log(`Idempotent retry: reconcile already applied.`);
  const { location, state } = loadState(root);
  assertKnownOwner(state, required(flags, "owner"));
  const item = state.human_overrides.find((entry) => entry.id === required(flags, "override-id"));
  if (!item || item.status !== "OPEN") throw new PlangonautError(`Open override not found: ${flags["override-id"]}`);
  // Reconciliation evidence is a document the recipient has to be able to read,
  // so it obeys the rule every other travelling record obeys: an existing,
  // non-empty file inside the project and outside the reserved `.beave`. It used
  // to be read from any absolute path the caller named, which is how a ledger
  // came to carry the digest of a document the package could not contain.
  const evidencePath = path.resolve(required(flags, "evidence-file"));
  const reconciliationEvidence = recordedSourceFile(root, "Reconciliation evidence", evidencePath, {
    suffix: "\nNothing was written.",
  });
  const evidenceRelative = reconciliationEvidence.relative;
  const bytes = fs.readFileSync(reconciliationEvidence.absolute);

  const supplied = typeof flags["next-action"] === "string" ? String(flags["next-action"]).trim() : null;
  if (typeof flags["next-action"] === "string" && !supplied) throw new PlangonautError(`--next-action cannot be empty. Omit it to keep what is recorded. Nothing was written.`);
  const replaceRequested = Boolean(flags["replace-human-next-action"]);
  const previousAction = typeof state.exact_next_action === "string" ? state.exact_next_action : "";
  const humanWroteIt = !engineWroteNextAction(previousAction);
  const open = state.human_overrides.filter((entry) => entry.status === "OPEN" && entry.id !== item.id);

  // The refusal is decided before anything is written, and it is skipped when
  // another override is still open: in that case nothing the caller supplied is
  // applied anyway, so there is no replacement to consent to.
  if (!open.length && humanWroteIt && supplied && supplied !== previousAction && !replaceRequested) {
    throw new PlangonautError(
      `Refusing to replace the exact next action: it was written by a person, and --next-action alone is not the intention to replace it.\n` +
      `  recorded: ${previousAction}\n` +
      `  supplied: ${supplied}\n` +
      `To keep the recorded sentence, re-run without --next-action.\n` +
      `To replace it deliberately, add --replace-human-next-action.\n` +
      `Nothing was written; ${item.id} is still OPEN.`
    );
  }
  if (replaceRequested && !supplied) {
    throw new PlangonautError(`--replace-human-next-action needs the sentence that replaces it: pass --next-action TEXT as well. Nothing was written.`);
  }

  const timestamp = now();
  Object.assign(item, { status: "RECONCILED", reconciled_by: required(flags, "owner"), reconciled_at: timestamp, reconciliation_evidence: evidenceRelative || path.basename(evidencePath), reconciliation_sha256: sha256(bytes) });
  state.needs_reconciliation = open.length > 0;

  let outcome: "generated" | "preserved" | "replaced" | "blocked_by_open_override";
  let resulting: string;
  if (open.length) {
    // With another override still open the blocker sentence has to win: the next
    // action is not what the operator planned, it is the reconciliation that has
    // to happen first. What is not allowed is doing that in silence — the operator
    // supplied a sentence and it went nowhere, which is the shape this release
    // refuses everywhere else it occurs.
    outcome = "blocked_by_open_override";
    resulting = `Reconcile ${open[0].id} before continuing.`;
  } else if (humanWroteIt && !supplied) {
    outcome = "preserved";
    resulting = previousAction;
  } else if (humanWroteIt) {
    outcome = supplied === previousAction ? "preserved" : "replaced";
    resulting = supplied!;
  } else {
    outcome = "generated";
    resulting = supplied ?? `Reconciled ${item.id}. Continue from the recorded plan; no next action was supplied.`;
  }
  state.exact_next_action = resulting;
  // `generated` means the engine owns the resulting sentence; the other three
  // leave the field belonging to whoever wrote it before, or to the operator who
  // deliberately replaced it.
  const provenance = outcome === "generated" ? "engine" : outcome === "blocked_by_open_override" ? "engine" : "human";

  state.updated_at = timestamp;
  const revision = state.revision + 1;
  const eventId = crypto.randomUUID();
  state.revision = revision;
  state.last_event_id = eventId;
  // `next_action_before` is the point of the whole record: the sentence a person
  // wrote used to vanish from the ledger, and the recipient of the folder must be
  // able to read what was replaced and by whom.
  const event = {
    event_id: eventId, type: "HUMAN_OVERRIDE_RECONCILED", state_revision: revision, at: timestamp,
    idempotency_key: key, override_id: item.id, owner: flags.owner,
    evidence: item.reconciliation_evidence, evidence_sha256: item.reconciliation_sha256,
    next_action_outcome: outcome,
    next_action_before: previousAction,
    next_action_after: resulting,
    next_action_provenance: provenance,
    next_action_supplied: supplied,
  };
  commitState(root, location, state, event);
  console.log(`Reconciled human override ${item.id}`);
  if (outcome === "preserved") {
    console.log(`
The exact next action was written by a person and is kept unchanged: "${resulting}"${supplied ? `
You supplied the same sentence, so nothing was replaced.` : ``}
To replace it deliberately, re-run with --next-action TEXT --replace-human-next-action, or use plangonaut checkpoint --next-action.`);
  } else if (outcome === "replaced") {
    console.log(`
The exact next action written by a person was replaced, as --replace-human-next-action asked.
  was: ${previousAction}
  now: ${resulting}
The previous sentence is kept verbatim in event ${eventId} as next_action_before.`);
  } else if (outcome === "blocked_by_open_override") {
    const others = open.length === 1 ? "one override is" : `${open.length} overrides are`;
    console.log(`
The next action was set to the blocker sentence, because ${others} still open and reconciling ${open[0].id} has to come first.
  was: ${previousAction || "<nothing recorded>"}
  now: ${resulting}${supplied ? `
The sentence you supplied was NOT recorded in state: "${supplied}"
Supply it again on the reconcile that closes the last open override, or write it deliberately afterwards with plangonaut checkpoint --next-action.` : ``}
The previous sentence is kept verbatim in event ${eventId} as next_action_before.`);
  } else {
    console.log(`
The exact next action is now: ${resulting}${supplied ? `` : `
No --next-action was supplied and nothing a person had written was recorded, so the engine wrote its own sentence. Replace it whenever you want with plangonaut checkpoint --next-action.`}`);
  }
}

function ledgerMutation(kind: string, flags: Flags): void {
  const rule = LEDGER_RULES[kind];
  if (!rule) throw new PlangonautError(`Unsupported ledger: ${kind}`);
  const root = resolveProject(required(flags, "project-root"));
  const key = idempotencyKey(flags);
  if (checkIdempotency(root, key)) return console.log(`Idempotent retry: ${kind} already applied.`);
  const { location, state } = loadState(root);
  assertNotBlocked(state);
  const owner = required(flags, "owner").trim();
  assertKnownOwner(state, owner);
  const id = required(flags, "id").toUpperCase();
  if (!validTypedId(id, rule.prefix)) throw new PlangonautError(`Invalid ${kind} ID: ${id}. Expected ${rule.prefix}- followed by uppercase letters, numbers, _ or -.`);
  const ledger = state[rule.array] as unknown as any[];
  const existing = ledger.find((item) => item.id === id);
  if (existing) {
    const expected = Number(required(flags, "expected-revision"));
    if (!Number.isInteger(expected) || expected !== existing.revision) throw new PlangonautError(`Stale ${kind} ${id}: expected revision ${existing.revision}. No changes written.`);
  }
  const timestamp = now();
  let record: any;
  let unprovenanced = false;
  if (kind === "decision" || kind === "requirement" || kind === "task") {
    const status = required(flags, "status").toUpperCase();
    if (!rule.statuses!.has(status)) throw new PlangonautError(`Unsupported ${kind} status: ${status}`);
    record = { id, title: required(flags, "title").trim(), status, owner };
    if (!record.title) throw new PlangonautError(`--title cannot be empty`);

    /*
     * The fields that make a task executable, recorded when given and absent
     * when not.
     *
     * Never defaulted. A task with no `kind` is a task whose kind nobody
     * recorded, and the readiness check reports it as exactly that; writing
     * `ADMINISTRATIVE` or `IMPLEMENTATION` here on the caller's behalf would
     * manufacture the one fact the whole check turns on.
     */
    if (kind === "task") {
      const text = (name: string): string | undefined => {
        const value = flags[name];
        return typeof value === "string" && value.trim() ? value.trim() : undefined;
      };
      const list = (name: string): string[] | undefined => {
        const value = text(name);
        if (!value) return undefined;
        const items = value.split(",").map((item) => item.trim()).filter(Boolean);
        return items.length ? items : undefined;
      };
      const optional: Record<string, unknown> = {
        kind: text("kind")?.toUpperCase(),
        requirements: list("requirements")?.map((item) => item.toUpperCase()),
        decisions: list("decisions")?.map((item) => item.toUpperCase()),
        component: text("component"),
        role: text("role"),
        acceptance: text("acceptance"),
        verification: text("verification"),
        evidence_expected: text("evidence-expected"),
        handoff: text("handoff"),
        estimate: text("estimate"),
        inputs: list("inputs"),
        outputs: list("outputs"),
        risks: list("risks")?.map((item) => item.toUpperCase()),
        ...(flags.parallelizable === true ? { parallelizable: true } : {}),
      };
      for (const [field, value] of Object.entries(optional)) {
        if (value !== undefined) record[field] = value;
      }

      // An origin that names nothing is worse than none: it reads as coverage.
      const known = knownRecordIds(state);
      for (const field of ["requirements", "decisions", "risks"]) {
        for (const id of (record[field] ?? []) as string[]) {
          if (!known.has(id)) throw new PlangonautError(`--${field} names ${id}, which no record answers to. Nothing was written.`);
        }
      }
    }

    // An approval has to be able to name who approved it. See
    // `findDecisionProvenance` for why reading a folder is not consent.
    if (kind === "decision" && status === "APPROVED") {
      /*
       * Where this rule is enforced, and why it is not here.
       *
       * The rule itself is not in doubt: an approval that cannot name who
       * approved it is an agent's inference wearing a decision's clothes. What
       * was in doubt is the layer, and measuring settled it. Refusing the write
       * broke 87 call sites across 13 test files, and not one of them is about
       * decisions -- they use `APPROVED` as a convenient status for a fixture.
       * A refusal there is not a guarantee, it is a migration nobody asked for,
       * and compatibility with what exists was a requirement.
       *
       * So the write records what it can see and says what it cannot:
       *
       *   here              provenance is recorded when it exists; a warning
       *                     names the three roads when it does not.
       *   validate          reports every unprovenanced approval; --strict fails.
       *   handoff-check     blocking. A folder does not get handed over resting
       *                     on approvals nobody can trace.
       *   the skill         carries the duty: if the user has not answered, the
       *                     status is PROPOSED.
       *
       * Three roads, and the third exists because Adoption and Reconstruction
       * are real: a project can arrive with decisions already taken, and a rule
       * that could only be satisfied by a Plangonaut interview would make those
       * modes unusable. A recorded statement is the same shape as an override --
       * a person's words, inside the folder, hashed - and carries the same
       * honest limit: the engine cannot tell who typed a file, only that the
       * record points at something a reader can go and read.
       */
      const citedOverride = nonEmpty(flags["provenance-override"]) ? String(flags["provenance-override"]).trim() : null;
      const citedNote = nonEmpty(flags["provenance-note"]) ? String(flags["provenance-note"]).trim() : null;

      let provenance: DecisionProvenance | null = null;
      if (citedOverride) {
        provenance = overrideProvenance(state, citedOverride);
        if (!provenance) {
          throw new PlangonautError(
            `--provenance-override names ${citedOverride}, which is not a recorded override in this project. Nothing was written.`
          );
        }
      } else if (citedNote) {
        const note = recordedSourceFile(root, "A provenance note", path.resolve(citedNote), {
          suffix: "\nNothing was written.",
        });
        provenance = { kind: "statement", ref: note.relative, authority: owner, at: timestamp, sha256: note.hash };
      } else {
        provenance = findDecisionProvenance(state, id);
      }

      if (provenance) {
        record.provenance = provenance;
      } else {
        unprovenanced = true;
      }
    }
  } else if (kind === "dependency") {
    const type = required(flags, "type").toUpperCase();
    if (!rule.statuses!.has(type)) throw new PlangonautError(`Unsupported dependency type: ${type}`);
    record = { id, from: required(flags, "from").toUpperCase(), to: required(flags, "to").toUpperCase(), type, owner };
  } else if (kind === "risk") {
    const status = required(flags, "status").toUpperCase();
    const severity = required(flags, "severity").toUpperCase();
    if (!rule.statuses!.has(status)) throw new PlangonautError(`Unsupported risk status: ${status}`);
    if (!new Set(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).has(severity)) throw new PlangonautError(`Unsupported risk severity: ${severity}`);
    record = { id, title: required(flags, "title").trim(), severity, status, owner };
    if (!record.title) throw new PlangonautError(`--title cannot be empty`);
  } else if (kind === "agent") {
    const status = required(flags, "status").toUpperCase();
    if (!rule.statuses!.has(status)) throw new PlangonautError(`Unsupported agent status: ${status}`);
    record = { id, name: required(flags, "name").trim(), status, owner };
    if (!record.name) throw new PlangonautError(`--name cannot be empty`);
    /*
     * What this executor is for, when somebody recorded it.
     *
     * An executor is a person, an organisation or an agent, and the ledger does
     * not rename itself for a project that builds a bridge. What it needs to
     * carry is the same in either case: what they do, what they own outright,
     * and whether they are the one who integrates or the one who reviews.
     */
    const agentText = (name: string): string | undefined => {
      const value = flags[name];
      return typeof value === "string" && value.trim() ? value.trim() : undefined;
    };
    const agentList = (name: string): string[] | undefined => {
      const value = agentText(name);
      if (!value) return undefined;
      const items = value.split(",").map((item) => item.trim()).filter(Boolean);
      return items.length ? items : undefined;
    };
    const agentOptional: Record<string, unknown> = {
      role: agentText("role"),
      skills: agentList("skills"),
      owns: agentList("owns"),
      authority: agentText("authority"),
      ...(flags["is-integrator"] === true ? { integrator: true } : {}),
      ...(flags["is-reviewer"] === true ? { reviewer: true } : {}),
    };
    for (const [field, value] of Object.entries(agentOptional)) {
      if (value !== undefined) record[field] = value;
    }
  } else if (kind === "evidence") {
    const verified = recordedSourceFile(root, "Evidence", path.resolve(required(flags, "file")), {
      suffix: "\nNothing was written.",
    });
    record = { id, path: verified.relative, sha256: verified.hash, owner };
  } else {
    record = { id, name: required(flags, "name").trim(), owner };
    if (!record.name) throw new PlangonautError(`--name cannot be empty`);
    if (!existing) record.created_at = timestamp;
  }
  record.revision = (existing?.revision ?? 0) + 1;
  record.updated_at = timestamp;
  if (existing && kind === "checkpoint") record.created_at = existing.created_at;
  if (existing) Object.assign(existing, record);
  else ledger.push(record);

  if (kind === "checkpoint" && typeof flags["next-action"] === "string") {
    const nextAction = String(flags["next-action"]).trim();
    if (!nextAction) throw new PlangonautError(`--next-action cannot be empty`);
    state.exact_next_action = nextAction;
  }

  state.updated_at = timestamp;
  const revision = state.revision + 1;
  const eventId = crypto.randomUUID();
  state.revision = revision;
  state.last_event_id = eventId;
  // D5. The status a ledger record was moved *to* was recorded nowhere: the event
  // carried the id, the revision and the owner, and the state carried only the
  // latest value. So no reader could tell that a task had been DONE and came back,
  // which is the observation the third loop condition is made of. It is written as
  // `record_status` — the ledger record's status, not the operation's — and it is
  // additive: every project written before this carries events without it, and
  // `reopenedRecords` simply sees nothing there rather than guessing.
  const event: any = { event_id: eventId, type: `${kind.toUpperCase()}_${existing ? "UPDATED" : "CREATED"}`, state_revision: revision, at: timestamp, idempotency_key: key, ledger_id: id, record_revision: record.revision, owner };
  if (typeof record.status === "string") event.record_status = record.status;
  commitState(root, location, state, event);
  console.log(`${existing ? "Updated" : "Created"} ${kind} ${id} at revision ${record.revision}`);
  if (unprovenanced) {
    console.log(
      `\nWARNING: ${id} is APPROVED and nothing records who approved it.` +
      `\nAn approval that cannot name its author is an inference wearing a decision's clothes. Three roads, and no fourth:` +
      `\n  the interview   settle the question it came from with --consequences ${id}` +
      `\n  an override     --provenance-override <OVR-ID>` +
      `\n  a statement     --provenance-note <a file inside the project, in the decider's own words>` +
      `\nplangonaut validate reports this; --strict fails on it; handoff-check refuses to hand the folder over with it.`
    );
  }
}

/**
 * The one check every file destined for a permanent record has to pass.
 *
 * There used to be three copies of it and one hole. `reconcile` carried the
 * check inline, the `evidence` ledger carried it again, `verifiedEvidence`
 * carried it a third time for gates, blockers and `re-record` — and `override`
 * carried none at all, so it accepted a path the other three refuse. The pilot
 * found the consequence rather than the cause: an override was recorded against
 * a file in a temporary directory, and `validate` refused the project days
 * later, by which time the file could have been gone and the override's own text
 * with it. An override is a change of direction; it is among the last things
 * that may evaporate.
 *
 * The asymmetry was the defect, so the remedy is one function rather than a
 * fourth copy. Everything it rejects it rejects for the same stated reason, and
 * the reason names the fix: bring the file inside the folder that travels with
 * the record.
 *
 * What is refused, all of it by the helpers that already existed:
 *
 *  - an absolute path, and a path climbing out of the root with `..`
 *    (`safeProjectRelative`, on the `/`-canonical spelling, so a Windows
 *    `..\..\x` is one climb and not one segment);
 *  - anything inside the reserved state directories (`safeArtifactPath`);
 *  - a symlink resolving outside the root, because `existingFileInside`
 *    compares real paths and not written ones;
 *  - a file that does not exist, is not a file, or is empty.
 *
 * A UNC path and a drive-qualified path are both absolute, so both land in the
 * first rule without needing one of their own.
 */
function recordedSourceFile(
  root: string,
  kind: string,
  sourcePath: string,
  options: { suffix?: string } = {}
): { relative: string; hash: string; absolute: string } {
  const tail = options.suffix ?? "";
  const relative = canonicalRelative(path.relative(root, sourcePath));
  const refusal = artifactPathRefusal(kind, relative);
  if (refusal) {
    throw new PlangonautError(
      `${refusal}\n` +
      `Copy or move the file into the project first, then pass its path relative to the root.${tail}`
    );
  }
  const confined = existingFileInside(root, relative);
  if (!confined) {
    throw new PlangonautError(
      `${kind} must be an existing file inside the project root: ${relative || path.basename(sourcePath)}\n` +
      `A symbolic link that resolves outside the root is refused for the same reason a path outside it is.${tail}`
    );
  }
  const bytes = fs.readFileSync(confined);
  if (!bytes.length || !bytes.toString("utf8").trim()) {
    throw new PlangonautError(`${kind} cannot be empty: ${relative || path.basename(sourcePath)}${tail}`);
  }
  return { relative: relative || path.basename(sourcePath), hash: sha256(bytes), absolute: confined };
}

function verifiedEvidence(root: string, sourcePath: string): { relative: string; hash: string } {
  const { relative, hash } = recordedSourceFile(root, "Evidence", sourcePath, { suffix: "\nNothing was written." });
  return { relative, hash };
}

function gatePrerequisiteErrors(root: string, state: State, gateId: string): string[] {
  const errors: string[] = [];
  const terminal = new Set(["CONFIRMED", "DEFERRED", "NOT APPLICABLE"]);
  const gate = Number(gateId.slice(1));
  const passed = (id: string) => state.gates.some((item) => item.name === id && new Set(["PASSED", "WARN", "NOT_APPLICABLE"]).has(item.status));
  if (gate > 1 && !passed(`G${gate - 1}`)) errors.push(`G${gate - 1} must be complete`);
  if (gate === 1 && !terminal.has(state.modules.find((item) => item.id === 1)?.status ?? "")) errors.push("module 1 must be resolved");
  if (gate === 2) {
    const unresolved = state.modules.filter((item) => !terminal.has(item.status)).map((item) => item.id);
    if (unresolved.length) errors.push(`all questionnaire modules must be resolved; open: ${unresolved.join(", ")}`);
    for (const item of state.modules.filter((module) => module.id > 0 && terminal.has(module.status) && module.status !== "NOT APPLICABLE")) {
      if (!item.evidence || !item.evidence_sha256) errors.push(`module ${item.id} has no hashed evidence`);
      else {
        const file = existingFileInside(root, item.evidence);
        if (!file) errors.push(`module ${item.id} evidence is missing or escapes the project root`);
        else if (sha256(fs.readFileSync(file)) !== item.evidence_sha256) errors.push(`module ${item.id} evidence hash does not match`);
      }
    }
  }
  if (gate === 4) {
    if (!state.decisions.some((item) => item.status === "APPROVED")) errors.push("at least one approved decision is required");
    if (!state.requirements.some((item) => item.status === "ACTIVE")) errors.push("at least one active requirement is required");
    if (!state.artifacts.some((item) => item.status === "PUBLISHED")) errors.push("at least one published artifact is required");
  }
  if (gate === 5 && !state.agents.some((item) => item.status === "ACTIVE")) errors.push("at least one active execution agent is required");
  if (gate === 6 && !state.checkpoints.length) errors.push("at least one checkpoint is required");
  if (gate === 7) {
    if (!state.tasks.length) errors.push("at least one task is required");
    const taskIds = new Set(state.tasks.map((item) => item.id));
    const directlyLinked = new Set(state.dependencies.flatMap((item) => taskIds.has(item.to) ? [item.from] : taskIds.has(item.from) ? [item.to] : []));
    const unmapped = state.requirements.filter((item) => item.status === "ACTIVE" && !directlyLinked.has(item.id)).map((item) => item.id);
    if (unmapped.length) errors.push(`active requirements lack task traceability: ${unmapped.join(", ")}`);
  }
  if (gate === 8 && state.tasks.some((item) => item.status !== "DONE")) errors.push("all tasks must be DONE");
  if (gate === 9 && !state.evidence.length) errors.push("verification evidence is required");
  if (gate >= 10) {
    const unsafe = state.risks.filter((item) => new Set(["HIGH", "CRITICAL"]).has(item.severity) && new Set(["IDENTIFIED", "REALIZED"]).has(item.status));
    if (unsafe.length) errors.push(`unresolved high risks: ${unsafe.map((item) => item.id).join(", ")}`);
  }
  // Open ones. A resolved blocker is history and must not hold a gate shut for
  // ever, which is what counting the whole array did.
  if (gate >= 11 && (openBlockers(state).length || state.needs_reconciliation)) errors.push("open blockers or reconciliation remain");
  if (gate === 12 && !state.checkpoints.length) errors.push("an operational checkpoint is required");
  return errors;
}

function lifecycleForGate(gateNumber: number): string {
  return gateNumber >= 12 ? "OPERATE" : gateNumber >= 11 ? "RELEASE" : gateNumber >= 8 ? "VERIFY" : gateNumber >= 7 ? "EXECUTE" : gateNumber >= 6 ? "PLAN" : gateNumber >= 5 ? "FOUNDATION" : gateNumber >= 4 ? "BLUEPRINT" : gateNumber >= 3 ? "RESEARCH" : gateNumber >= 2 ? "INTERVIEW" : "DISCOVERY";
}

function gate(flags: Flags): void {
  const root = resolveProject(required(flags, "project-root"));
  const key = idempotencyKey(flags);
  if (checkIdempotency(root, key)) return console.log(`Idempotent retry: gate already applied.`);
  const state = validateRoot(root, true);
  const location = path.join(stateRoot(root), "state.json");
  assertNotBlocked(state);
  assertKnownOwner(state, required(flags, "owner"));
  const gateId = required(flags, "id");
  const status = required(flags, "status");
  if (!new Set(["PASSED", "WARN", "BLOCKED", "NOT_APPLICABLE"]).has(status)) {
    throw new PlangonautError(`Invalid gate status: ${status}. Must be PASSED, WARN, BLOCKED, or NOT_APPLICABLE.`);
  }
  if (!/^G([0-9]|1[0-2])$/.test(gateId)) {
    throw new PlangonautError(`Invalid gate ID: ${gateId}. Must be G0 through G12.`);
  }
  
  const gateNumber = parseInt(gateId.slice(1), 10);
  const currentGateNumber = parseInt(state.current_gate.slice(1), 10);
  if (gateNumber > currentGateNumber) {
    throw new PlangonautError(`Cannot process ${gateId} before completing ${state.current_gate}`);
  }
  
  const sourcePath = flags["evidence-file"] ? path.resolve(String(flags["evidence-file"])) : null;
  let evidenceStr = null, evidenceSha256 = null;
  if (sourcePath) {
    const evidence = verifiedEvidence(root, sourcePath);
    evidenceStr = evidence.relative;
    evidenceSha256 = evidence.hash;
  } else {
    throw new PlangonautError("--evidence-file is required for every gate outcome");
  }

  if (status === "PASSED" || status === "WARN" || status === "NOT_APPLICABLE") {
    const prerequisiteErrors = gatePrerequisiteErrors(root, state, gateId);
    if (prerequisiteErrors.length) throw new PlangonautError(`Cannot complete ${gateId}:\n- ${prerequisiteErrors.join("\n- ")}`);
  }

  // `lifecycle.md` line 55: "WARN requires an owner, consequence, and review
  // date." The engine kept none of the three, and advanced the lifecycle exactly
  // as a PASSED would — so a conditional pass and an unconditional one were
  // indistinguishable in the state, in `status`, and in the next gate's
  // prerequisite check. Demonstrated by an A/B pair of identical projects during
  // the ALN-005 pilots: every observable field matched.
  const consequence = flags.consequence ? String(flags.consequence).trim() : "";
  const reviewDate = flags["review-date"] ? String(flags["review-date"]).trim() : "";
  if (status === "WARN") {
    if (!consequence || !reviewDate) {
      throw new PlangonautError(
        `A WARN gate requires --consequence and --review-date as well as --owner (lifecycle.md: "WARN requires an owner, consequence, and review date"). Nothing was written.`
      );
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(reviewDate)) {
      throw new PlangonautError(`--review-date must be an ISO date (YYYY-MM-DD); received ${reviewDate}`);
    }
  } else if (consequence || reviewDate) {
    throw new PlangonautError(`--consequence and --review-date belong to a WARN outcome, not to ${status}`);
  }
  
  const timestamp = now();
  // The gate record used to carry `{id, name, status}` and nothing else: the
  // owner, the evidence and its digest existed only on the event, so a reader of
  // `state.json` — Studio included — could see that a gate had passed and not on
  // what authority or against which file.
  const record = {
    status,
    owner: String(flags.owner),
    evidence: evidenceStr,
    evidence_sha256: evidenceSha256,
    updated_at: timestamp,
    consequence: status === "WARN" ? consequence : null,
    review_date: status === "WARN" ? reviewDate : null,
  };
  const existing = state.gates.find((g) => g.id === gateId || g.name === gateId);
  if (existing) {
    Object.assign(existing, record);
  } else {
    // Generate a proper GAT- ID, use the provided id as name for easy lookup
    state.gates.push({ id: `GAT-${crypto.randomBytes(4).toString("hex")}`, name: gateId, ...record });
  }
  
  let gateNextActionNote: string | null = null;
  if ((status === "PASSED" || status === "WARN" || status === "NOT_APPLICABLE") && gateId === state.current_gate) {
    const nextNum = gateNumber + 1;
    if (nextNum <= 12) {
      state.current_gate = `G${nextNum}`;
      state.lifecycle_state = lifecycleForGate(nextNum);
    }
    // Same rule as `record`: the engine advances its own sentence and keeps a
    // person's. A gate outcome is not an instruction to whoever receives the
    // folder.
    // Flattened like every other generated sentence: a multi-line `--consequence`
    // used to break the `- Exact next action:` item in `resume` and the context
    // pack, spilling the rest into a bare paragraph. The re-check of the earlier
    // fix found this branch had been missed while the one with no free text in
    // it was flattened.
    gateNextActionNote = advanceGeneratedNextAction(
      state,
      generatedSentence(
        status === "WARN"
          ? `Proceed to ${state.current_gate}. ${gateId} passed with a condition owned by ${flags.owner}, to review by ${reviewDate}: ${consequence}`
          : `Proceed to ${state.current_gate}.`,
      ),
    );
  } else if (status === "BLOCKED") {
    if (gateNumber < currentGateNumber) {
      state.current_gate = gateId;
      state.lifecycle_state = lifecycleForGate(gateNumber);
    }
    gateNextActionNote = advanceGeneratedNextAction(state, generatedSentence(`Resolve blockers for ${gateId} and retry.`));
  }
  
  state.updated_at = timestamp;
  const revision = state.revision + 1;
  const eventId = crypto.randomUUID();
  state.revision = revision;
  state.last_event_id = eventId;
  const event = { event_id: eventId, type: "GATE_UPDATED", state_revision: revision, at: timestamp, idempotency_key: key, gate_id: gateId, status, owner: flags.owner, evidence: evidenceStr, evidence_sha256: evidenceSha256, consequence: record.consequence, review_date: record.review_date };
  commitState(root, location, state, event);
  console.log(`Recorded gate ${gateId} as ${status}`);
  if (gateNextActionNote) console.log(`
${gateNextActionNote}`);
}

function contextPack(flags: Flags): void {
  const root = resolveProject(required(flags, "project-root"));
  // The pack carries the last few history entries as well as the current forecast:
  // a recipient has to be able to see that a forecast changed and why, not only
  // where it landed.
  const content = contextMarkdown(validateRoot(root), 3);
  if (!flags.output) return console.log(content.trimEnd());
  const relative = String(flags.output);
  if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes("..")) throw new PlangonautError("Context output must stay under .beave/context");
  const output = boundedOutput(stateRoot(root), path.join("context", relative));
  atomicWrite(output, content);
  console.log(`Wrote context pack to ${output}`);
}

function copyFileCreatingParents(source: string, destination: string): void {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

function packageManifest(packageRoot: string): any {
  const location = path.join(packageRoot, "manifest.json");
  const manifest = readJson(location);
  if (!PACKAGE_FORMATS.includes(String(manifest.format)) || !Array.isArray(manifest.files)) throw new PlangonautError(`Unsupported project package manifest`);
  const seen = new Set<string>();
  for (const item of manifest.files) {
    if (!safeProjectRelative(item?.path) || !/^[a-f0-9]{64}$/.test(item?.sha256 ?? "") || !Number.isInteger(item?.bytes) || item.bytes < 0) throw new PlangonautError(`Invalid package file entry`);
    // Blocker 4. The package is the thing that crosses machines, so its manifest
    // is held to the canonical spelling rather than merely tolerating both: a
    // `files\docs\plan.md` entry is a single file name on the recipient's POSIX
    // filesystem, and the package would unpack into something nobody asked for.
    if (String(item.path).includes("\\")) throw new PlangonautError(`Package file entry must use "/" as its separator, not "\\": ${item.path}`);
    if (!(item.path === "state/state.json" || item.path === "state/events.jsonl" || item.path === manifest.entrypoint || item.path.startsWith("files/") || item.path.startsWith("history/") || item.path.startsWith("deletion-reasons/"))) throw new PlangonautError(`Unsupported package file entry: ${item.path}`);
    // `history/` lands in `.beave/history/` on import, which is a directory the
    // engine owns: one flat filename, no separators, no traversal.
    if (item.path.startsWith("history/")) {
      const name = item.path.slice("history/".length);
      if (!name || name.includes("/") || name.includes("\\") || name.startsWith(".")) throw new PlangonautError(`Unsafe history entry: ${item.path}`);
    }
    // Same shape, same rule: `deletion-reasons/` lands in `.beave/deletion-reasons/`.
    if (item.path.startsWith("deletion-reasons/")) {
      const name = item.path.slice("deletion-reasons/".length);
      if (!name || name.includes("/") || name.includes("\\") || name.startsWith(".")) throw new PlangonautError(`Unsafe deletion-reason entry: ${item.path}`);
    }
    if (item.path.startsWith("files/") && !safeArtifactPath(item.path.slice("files/".length))) throw new PlangonautError(`Package file targets a reserved or unsafe project path: ${item.path}`);
    if (seen.has(item.path)) throw new PlangonautError(`Duplicate package file entry: ${item.path}`);
    seen.add(item.path);
    const location = existingFileInside(packageRoot, item.path);
    if (!location) throw new PlangonautError(`Package file is missing or escapes the package root: ${item.path}`);
    if (fs.statSync(location).size !== item.bytes) throw new PlangonautError(`Package byte count mismatch: ${item.path}`);
    if (sha256(fs.readFileSync(location)) !== item.sha256) throw new PlangonautError(`Package digest mismatch: ${item.path}`);
  }
  for (const requiredFile of ["state/state.json", "state/events.jsonl"]) if (!seen.has(requiredFile)) throw new PlangonautError(`Package is missing ${requiredFile}`);
  if (!safeProjectRelative(manifest.entrypoint) || !seen.has(manifest.entrypoint)) throw new PlangonautError(`Package entrypoint is invalid or missing`);
  const embedded = readJson(path.join(packageRoot, "state", "state.json"));
  if (manifest.project_name !== embedded.project?.name || manifest.state_revision !== embedded.revision || manifest.schema_version !== embedded.schema_version) throw new PlangonautError(`Package metadata does not match embedded state`);
  const embeddedEvents = fs.readFileSync(path.join(packageRoot, "state", "events.jsonl"), "utf8").split(/\r?\n/).filter(Boolean).map((line, index) => { try { return JSON.parse(line); } catch { throw new PlangonautError(`Invalid embedded event JSON at line ${index + 1}`); } });
  const latest = embeddedEvents.at(-1);
  if (!latest || latest.event_id !== embedded.last_event_id || latest.state_revision !== embedded.revision) throw new PlangonautError(`Embedded state does not match its latest event`);
  for (const artifact of embedded.artifacts ?? []) {
    if (!safeArtifactPath(artifact.working_path)) throw new PlangonautError(`Embedded artifact has unsafe path: ${artifact.id}`);
    const workingEntry = `files/${canonicalRelative(artifact.working_path)}`;
    if (!seen.has(workingEntry)) throw new PlangonautError(`Package is missing current artifact file: ${workingEntry}`);
    if (sha256(fs.readFileSync(path.join(packageRoot, workingEntry))) !== artifact.content_hash) throw new PlangonautError(`Embedded artifact hash mismatch: ${artifact.id}`);
    if (artifact.status === "PUBLISHED" && !seen.has(`files/${canonicalRelative(artifact.base_path)}`)) throw new PlangonautError(`Package is missing published artifact: ${artifact.base_path}`);
  }
  for (const evidence of embedded.evidence ?? []) {
    if (!safeArtifactPath(evidence.path) || !seen.has(`files/${canonicalRelative(evidence.path)}`)) throw new PlangonautError(`Package is missing or contains unsafe evidence: ${evidence.id}`);
  }
  // Blocker 3. Same rule for the account of what was done about a human override:
  // the ledger carries a digest, so the package has to carry the document, and a
  // recipient has to be told when it does not — or when what arrived is not what
  // the digest describes.
  const reconciliationRecovery =
    `\nSafe next action: reject this package and return to the source project. Restore the evidence file recorded by the ledger, ` +
    `or resolve its loss through a new governed override and reconciliation cycle; then run project-export into a new empty directory ` +
    `and run project-verify on that new package. Do not edit the rejected package or its manifest.`;
  for (const override of embedded.human_overrides ?? []) {
    const relative = override?.reconciliation_evidence;
    if (typeof relative !== "string" || !relative.trim()) continue;
    if (!safeArtifactPath(relative)) throw new PlangonautError(`Package carries an unsafe reconciliation evidence path for ${override.id}: ${relative}${reconciliationRecovery}`);
    const entry = `files/${canonicalRelative(relative)}`;
    if (!seen.has(entry)) throw new PlangonautError(`Package is missing the reconciliation evidence for ${override.id}: ${entry}${reconciliationRecovery}`);
    const digest = override.reconciliation_sha256;
    if (typeof digest === "string" && /^[a-f0-9]{64}$/.test(digest)) {
      const location = existingFileInside(packageRoot, entry);
      if (!location) throw new PlangonautError(`Package is missing the reconciliation evidence for ${override.id}: ${entry}${reconciliationRecovery}`);
      if (sha256(fs.readFileSync(location)) !== digest) throw new PlangonautError(`Reconciliation evidence digest mismatch for ${override.id}: ${entry} does not match the digest recorded in the ledger${reconciliationRecovery}`);
    }
  }
  return manifest;
}

// ---------------------------------------------------------------------------
// Staging directories, for export and import
//
// A rename promotes a whole directory at once, which is why the final folder is
// never half a package. What was missing is everything before the rename: a
// killed process left `.name.<uuid>.tmp` beside the destination and no command
// would ever mention it again.
//
// The marker is what makes the directory recognisable as Plangonaut's own. Nothing
// removes a directory that does not carry one -- a user's folder that happens to
// look temporary is a user's folder.
// ---------------------------------------------------------------------------

/**
 * The names an unfinished piece of work leaves on disk.
 *
 * Every one of these is written by this engine and read back by it, sometimes
 * across versions: a package exported by `0.2.x` has to import here, and a
 * staging directory abandoned by a killed `0.2.x` process has to be recognised
 * as abandoned rather than mistaken for a package. So the new spelling is what
 * gets written, and both spellings are what gets read — which is the whole
 * shape of this rename in one place.
 */
const STAGING_MARKER = ".plangonaut-staging.json";
const LEGACY_STAGING_MARKER = ".beave-staging.json";
const STAGING_FORMAT = "plangonaut-staging-v1";
const STAGING_FORMATS = [STAGING_FORMAT, "beave-staging-v1"];
const FILE_TRANSACTION_FORMAT = "plangonaut-file-transaction-v2";
const FILE_TRANSACTION_FORMATS = [FILE_TRANSACTION_FORMAT, "beave-file-transaction-v2"];
const PACKAGE_FORMAT = "plangonaut-project-package-v1";
const PACKAGE_FORMATS = [PACKAGE_FORMAT, "beave-project-package-v1"];


type StagingPhase = "OPENED" | "COPYING" | "MANIFEST" | "VERIFIED" | "PROMOTING";

interface StagingMarker {
  format: string;
  kind: "export" | "import";
  staging_id: string;
  operation_id: string | null;
  source: string;
  destination: string;
  phase: StagingPhase;
  pid: number;
  host: string;
  created_at: string;
  updated_at: string;
  /** Set once the content is complete, so a recovery can tell what it is holding. */
  expected_files: number | null;
  expected_manifest_sha256: string | null;
}

/**
 * The marker beside a staging directory, in whichever spelling wrote it.
 *
 * A staging directory abandoned by a killed `0.2.x` process carries the old
 * name. Looking only for the new one would make that directory unrecognisable —
 * and an unrecognised staging directory is offered to the user as a package,
 * which is the one outcome this marker exists to prevent.
 */
function stagingMarkerPath(staging: string): string {
  const current = path.join(staging, STAGING_MARKER);
  if (fs.existsSync(current)) return current;
  const legacy = path.join(staging, LEGACY_STAGING_MARKER);
  return fs.existsSync(legacy) ? legacy : current;
}

/**
 * A pointer inside the project, so `recover` and `resume` can see an export that
 * did not finish.
 *
 * The staging itself lives beside the *destination*, which is wherever the user
 * asked for the package — not somewhere a command run inside the project would
 * ever look. The pointer is what closes that gap. An import has no project to
 * point from until it succeeds, which is stated rather than papered over: an
 * interrupted import is resolved by the next import to the same destination.
 */
function noteStagingInProject(root: string | null, staging: string, marker: StagingMarker): void {
  if (!root) return;
  try {
    writeJson(path.join(stateRoot(root), "staging", `${marker.staging_id}.json`), { ...marker, staging_directory: staging });
  } catch {
    // Diagnostics. An export must not fail because a note could not be written.
  }
}

function forgetStagingNote(root: string | null, stagingId: string): void {
  if (!root) return;
  try {
    fs.rmSync(path.join(stateRoot(root), "staging", `${stagingId}.json`), { force: true });
  } catch {
    // Same reasoning.
  }
}

/**
 * Clear every staging this project recorded and never finished.
 *
 * Keyed on the project's own notes rather than on a destination, because an
 * export interrupted on the way to one folder must not survive because the next
 * export happens to be going somewhere else. A staging whose process is still
 * running is left alone by `resolveAbandonedStagings`.
 */
function clearOwnAbandonedStagings(root: string): string[] {
  const notes: string[] = [];
  for (const item of outstandingStagings(root)) {
    if (item.alive) continue;
    /*
     * The staging is gone but its destination may be carrying the marker: that
     * is a crash in the window between the rename and the marker's removal, and
     * it means the operation *finished*. Clear the one file it left.
     */
    const destination = String(item.note.destination);
    if (!item.present && fs.existsSync(stagingMarkerPath(destination))) {
      const stray = readStagingMarker(destination);
      if (stray && path.resolve(stray.destination) === path.resolve(destination)) {
        fs.rmSync(stagingMarkerPath(destination), { force: true });
        notes.push(`cleared the staging marker left inside the completed ${item.note.kind} at ${path.basename(destination)}`);
      }
    }
    if (item.present) {
      const directory = String(item.note.staging_directory);
      const parent = path.dirname(directory);
      notes.push(...resolveAbandonedStagings(parent, String(item.note.destination), root));
      /*
       * The marker leaves just before the rename, so a crash in that window
       * leaves a directory with nothing inside it saying whose it is. The note
       * in this project's own `.beave/` is the provenance instead, and it is
       * the stronger of the two: Plangonaut wrote it, it names this exact path, and
       * that path is not the destination. Without this the directory would sit
       * there for ever — which is the defect this whole section exists for.
       */
      if (fs.existsSync(directory) && path.resolve(directory) !== path.resolve(String(item.note.destination))) {
        fs.rmSync(directory, { recursive: true, force: true });
        notes.push(`discarded an unfinished ${item.note.kind} staging recorded by this project at ${path.basename(directory)}`);
      }
    }
    forgetStagingNote(root, String(item.note.staging_id));
  }
  return notes;
}

/** Export stagings this project started and never finished. */
function outstandingStagings(root: string): Array<{ note: any; present: boolean; alive: boolean; leftover?: boolean }> {
  const directory = path.join(stateRoot(root), "staging");
  if (!fs.existsSync(directory)) return [];
  const found: Array<{ note: any; present: boolean; alive: boolean; leftover?: boolean }> = [];
  for (const entry of fs.readdirSync(directory)) {
    if (!entry.endsWith(".json")) continue;
    let note: any;
    try {
      note = readJson(path.join(directory, entry));
    } catch {
      continue;
    }
    const present = typeof note.staging_directory === "string" && fs.existsSync(note.staging_directory);
    // `!== false` on purpose: a pid this engine cannot read counts as possibly
    // alive, so an unreadable note is reported rather than quietly discarded.
    const alive = note.host === os.hostname() && processIsAlive(note.pid) !== false;
    // The note is a snapshot taken when the staging opened; the marker inside it
    // is what the operation actually reached. Reporting the snapshot would tell
    // the user a phase the operation left behind long ago.
    /*
     * Where the marker actually is, which is not always the staging directory.
     *
     * Past the rename there is no staging directory any more: the marker is
     * inside the *promoted* destination, which is what makes that promotion
     * recognisable. Reading only the staging meant `recover` reported "the
     * staging directory is no longer there, so the operation left nothing
     * behind" — and then `--apply` removed the marker it had just said did not
     * exist, and reported a phase (`OPENED`) the operation had left long before.
     * A fourth independent review read the two outputs side by side.
     */
    const promotedMarker = typeof note.destination === "string" ? readStagingMarker(String(note.destination)) : null;
    const live = present ? readStagingMarker(String(note.staging_directory)) : promotedMarker;
    found.push({
      note: live ? { ...note, ...live, staging_directory: note.staging_directory } : note,
      present,
      alive,
      leftover: !present && promotedMarker !== null,
    } as any);
  }
  return found;
}

function openStaging(
  staging: string,
  marker: Omit<StagingMarker, "format" | "phase" | "pid" | "host" | "created_at" | "updated_at" | "expected_files" | "expected_manifest_sha256">,
  projectRoot: string | null = null,
): void {
  faultPoint("staging-before-open");
  fs.mkdirSync(staging, { recursive: true });
  const at = now();
  writeTransientJson(stagingMarkerPath(staging), {
    format: STAGING_FORMAT,
    ...marker,
    phase: "OPENED" satisfies StagingPhase,
    pid: process.pid,
    host: os.hostname(),
    created_at: at,
    updated_at: at,
    expected_files: null,
    expected_manifest_sha256: null,
  } satisfies StagingMarker);
  // The note goes in before the fault point, not after the function returns: a
  // crash between the two left a staging directory the project had no record of,
  // which only an export to the very same destination would ever clear.
  noteStagingInProject(projectRoot, staging, readStagingMarker(staging)!);
  faultPoint("staging-after-marker");
}

function stagingPhase(staging: string, phase: StagingPhase, extra: Partial<StagingMarker> = {}): void {
  const marker = readJson(stagingMarkerPath(staging)) as StagingMarker;
  writeTransientJson(stagingMarkerPath(staging), { ...marker, ...extra, phase, updated_at: now() });
}

function readStagingMarker(staging: string): StagingMarker | null {
  const file = stagingMarkerPath(staging);
  if (!fs.existsSync(file)) return null;
  try {
    const value = readJson(file) as StagingMarker;
    return STAGING_FORMATS.includes(String(value?.format)) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Plangonaut's own abandoned staging directories beside a destination.
 *
 * Identified by the marker and by nothing else -- not by the name, not by the
 * extension. A directory without one is left exactly where it is and is not even
 * reported as Plangonaut's, because it is not.
 */
function abandonedStagings(parent: string, destination: string | null): Array<{ directory: string; marker: StagingMarker }> {
  if (!fs.existsSync(parent)) return [];
  const found: Array<{ directory: string; marker: StagingMarker }> = [];
  // The destination itself is scanned too: a marker that survived the rename is
  // sitting inside the finished folder, and that is the case below.
  for (const entry of fs.readdirSync(parent)) {
    const candidate = path.join(parent, entry);
    let isDirectory = false;
    try {
      isDirectory = fs.statSync(candidate).isDirectory();
    } catch {
      continue;
    }
    if (!isDirectory) continue;
    const marker = readStagingMarker(candidate);
    if (!marker) continue;
    if (destination !== null && path.resolve(marker.destination) !== path.resolve(destination)) continue;
    found.push({ directory: candidate, marker });
  }
  return found;
}

/**
 * Resolve a staging directory left by a process that is gone.
 *
 * The rule is the one the rename already implies: the destination appears whole
 * or not at all, so an interrupted staging is *discarded*, never promoted. There
 * is no half-finished package worth keeping -- the operation is cheap to repeat
 * and the inputs are all still there. A staging whose process is still alive is
 * left alone.
 */
function resolveAbandonedStagings(parent: string, destination: string | null, receiptRoot: string | null): string[] {
  const notes: string[] = [];
  for (const { directory, marker } of abandonedStagings(parent, destination)) {
    /*
     * The marker is inside the directory it was going to become. The rename
     * happened, so the operation finished and only the marker is left. The
     * marker goes; the directory, which is now somebody's package or somebody's
     * project, is not touched.
     */
    if (path.resolve(directory) === path.resolve(marker.destination)) {
      fs.rmSync(stagingMarkerPath(directory), { force: true });
      notes.push(`cleared the staging marker left inside the completed ${marker.kind} at ${path.basename(directory)}`);
      continue;
    }
    if (marker.host === os.hostname() && marker.pid !== process.pid && processIsAlive(marker.pid) !== false) {
      throw new PlangonautError(
        `Another Plangonaut ${marker.kind} is running against ${marker.destination}: process ${marker.pid} on ${marker.host}, since ${marker.created_at}. ` +
          `Nothing was changed. Wait for it to finish, or stop that process.`,
      );
    }
    if (marker.host !== os.hostname()) {
      throw new PlangonautError(
        `An unfinished Plangonaut ${marker.kind} from another machine is beside this destination: ${path.basename(directory)}, from ${marker.host}, since ${marker.created_at}. ` +
          `Plangonaut cannot tell whether that machine is still working, so it will not remove it. Look at it, then delete it by hand and run this command again. Nothing was changed.`,
      );
    }
    // This host, and the process is gone. The directory is Plangonaut's own, it is
    // incomplete by definition, and discarding it loses nothing that is not
    // still in the project it came from.
    fs.rmSync(directory, { recursive: true, force: true });
    notes.push(`discarded an unfinished ${marker.kind} staging left by process ${marker.pid} at phase ${marker.phase} (${marker.created_at})`);
    if (receiptRoot) {
      writeJson(path.join(stateRoot(receiptRoot), "recovery", `${marker.staging_id}.staging-discarded.json`), {
        ...marker,
        recovered_at: now(),
        outcome: "DISCARDED",
        reason: "the process that opened it is no longer running on this host, and an unfinished package is never promoted",
      });
    }
  }
  return notes;
}

function projectExport(flags: Flags): void {
  const root = resolveProject(required(flags, "project-root"));
  const state = validateRoot(root, true);
  const destination = path.resolve(required(flags, "output-dir"));
  const parent = path.dirname(destination);
  fs.mkdirSync(parent, { recursive: true });
  /*
   * Recovery first, refusal second.
   *
   * "The destination already exists" was checked before any of this, so a
   * package left carrying a staging marker by a crash in the rename window could
   * only be cleaned by exporting somewhere *else* — the one command that
   * recognises the marker refused before reaching it.
   */
  for (const note of clearOwnAbandonedStagings(root)) console.log(`Recovered: ${note}.`);
  for (const note of resolveAbandonedStagings(parent, destination, root)) console.log(`Recovered: ${note}.`);
  if (fs.existsSync(destination)) throw new PlangonautError(`Refusing to overwrite existing project package: ${destination}`);
  const staging = path.join(parent, `.${path.basename(destination)}.${crypto.randomUUID()}.tmp`);
  const published = state.artifacts.filter((item) => item.status === "PUBLISHED" && item.base_path.toLowerCase().endsWith(".md"));
  // Blocker 6. This refusal named the rule and not the way out — the only engine
  // error that told the operator what was wrong without telling them what to do.
  // The gate is unchanged and nothing is published automatically: publishing a
  // document is a human decision, and an export command that made it would be a
  // worse defect than an unhelpful message.
  if (!published.length) {
    const drafts = state.artifacts.filter((item) => item.status !== "PUBLISHED" && item.base_path.toLowerCase().endsWith(".md"));
    const nonMarkdown = state.artifacts.filter((item) => item.status === "PUBLISHED" && !item.base_path.toLowerCase().endsWith(".md"));
    const lines = [
      `Nothing to hand off: the package must carry at least one PUBLISHED Markdown document, and this project has none.`,
      ``,
      `What is missing: a document whose status is PUBLISHED and whose base_path ends in .md. A recipient reads the folder, not your terminal, so a package of state without a document to act on is a package nobody can use.`,
      ``,
    ];
    if (drafts.length) {
      const candidate = drafts[0];
      lines.push(
        `What you have: ${drafts.length} Markdown document${drafts.length === 1 ? "" : "s"} still in DRAFT — ${drafts.slice(0, 5).map((item) => `${item.id} (${item.base_path})`).join(", ")}${drafts.length > 5 ? ", …" : ""}.`,
        ``,
        `The safe action, for a document you have decided is ready:`,
        `  plangonaut doc-finalize --project-root . --id ${candidate.id} --owner <owner> --operation-id <id>`,
        ``,
        `That is the step that publishes ${candidate.base_path}; this command will not take it for you. Then re-run project-export.`,
      );
    } else if (nonMarkdown.length) {
      lines.push(
        `What you have: ${nonMarkdown.length} PUBLISHED document${nonMarkdown.length === 1 ? "" : "s"}, none of them Markdown — ${nonMarkdown.slice(0, 5).map((item) => `${item.id} (${item.base_path})`).join(", ")}${nonMarkdown.length > 5 ? ", …" : ""}.`,
        ``,
        `The safe action: record the handoff document as Markdown and publish it.`,
        `  plangonaut doc-diff --project-root . --id ART-HANDOFF --base-path docs/HANDOFF.md --content-file <file> --owner <owner>`,
        `  plangonaut doc-save --project-root . --id ART-HANDOFF --base-path docs/HANDOFF.md --content-file <file> --owner <owner> --confirm-token <token from doc-diff> --operation-id <id>`,
        `  plangonaut doc-finalize --project-root . --id ART-HANDOFF --owner <owner> --operation-id <id>`,
        ``,
        `Then re-run project-export.`,
      );
    } else {
      lines.push(
        `What you have: no documents at all in the ledger.`,
        ``,
        `The safe action: write the handoff document, record it, then publish it.`,
        `  plangonaut doc-diff --project-root . --id ART-HANDOFF --base-path docs/HANDOFF.md --content-file <file> --owner <owner>`,
        `  plangonaut doc-save --project-root . --id ART-HANDOFF --base-path docs/HANDOFF.md --content-file <file> --owner <owner> --confirm-token <token from doc-diff> --operation-id <id>`,
        `  plangonaut doc-finalize --project-root . --id ART-HANDOFF --owner <owner> --operation-id <id>`,
        ``,
        `Then re-run project-export.`,
      );
    }
    lines.push(``, `Nothing was written and no document was published.`);
    throw new PlangonautError(lines.join("\n"));
  }
  const sources = new Map<string, string>();
  /*
   * The two state files are *built* for the package, not copied into it.
   *
   * `project.root` is an absolute path on the exporting machine, and it was in
   * two places: `state.json`, and the first event's patch, which is where the
   * whole state was written when the project began. A handoff therefore carried
   * the user's name, the drive letter and the folder layout of whoever made it —
   * to anybody they gave it to, for ever, in a file the recipient has no reason
   * to read. It is also useless there: the import rewrites it on arrival.
   *
   * Rewriting the recorded events was never an option — this system does not
   * edit history. So the package gets a *portable replay origin* instead: one
   * event, `PROJECT_PACKAGE_EXPORTED`, whose patch is the whole state with the
   * root emptied, and which records the digest, the length and the last event id
   * of the history it was made from. The recipient can replay everything from
   * the moment the package was made. What came before is attested by that digest
   * and is not claimed to be reproduced, because it is not there.
   *
   * The source project is not touched: nothing below writes into `root`.
   */
  const generated = new Map<string, string>();
  for (const artifact of state.artifacts) {
    if (artifact.working_path) sources.set(`files/${artifact.working_path.replaceAll("\\", "/")}`, resolveRecorded(root, artifact.working_path));
    if (artifact.status === "PUBLISHED") sources.set(`files/${artifact.base_path.replaceAll("\\", "/")}`, resolveRecorded(root, artifact.base_path));
  }
  for (const evidence of state.evidence) sources.set(`files/${evidence.path.replaceAll("\\", "/")}`, resolveRecorded(root, evidence.path));
  // Everything else the ledger points at, for the same reason: a delivered folder
  // whose state references a file the package left behind fails `validate` in the
  // recipient's hands, and for a gate it failed without even saying which file.
  for (const override of state.human_overrides ?? []) {
    const relative = (override as any).source;
    if (typeof relative === "string" && safeArtifactPath(relative) && existingFileInside(root, relative)) {
      sources.set(`files/${canonicalRelative(relative)}`, resolveRecorded(root, relative));
    }
    // Blocker 3. The reconciliation evidence is the account of what was done about
    // a human override, and the ledger carries its SHA-256. The package carried the
    // digest and not the document: `validate`, `project-verify` and `status` all
    // exited 0 on a folder whose ledger pointed at a file that was not in it.
    const reconciliation = (override as any).reconciliation_evidence;
    if (typeof reconciliation === "string" && reconciliation.trim()) {
      if (!safeArtifactPath(reconciliation)) {
        throw new PlangonautError(
          `Override ${(override as any).id} records reconciliation evidence at ${reconciliation}, which cannot travel in the package: it is absolute, climbs out of the project with "..", or sits inside the reserved .plangonaut directory.\n` +
          `A package must carry every document its ledger points at. Move the file inside the project, outside .beave, and record the reconciliation against it. Nothing was written.`
        );
      }
      if (!existingFileInside(root, reconciliation)) {
        throw new PlangonautError(
          `Override ${(override as any).id} records reconciliation evidence at ${reconciliation}, and that file is missing from the project.\n` +
          `Restore it, then re-run project-export. A package that carried the digest without the document is exactly the defect this refusal exists for. Nothing was written.`
        );
      }
      sources.set(`files/${canonicalRelative(reconciliation)}`, resolveRecorded(root, reconciliation));
    }
  }
  for (const gate of state.gates ?? []) {
    const relative = (gate as any).evidence;
    if (typeof relative === "string" && safeArtifactPath(relative) && existingFileInside(root, relative)) {
      sources.set(`files/${relative.replaceAll("\\", "/")}`, resolveRecorded(root, relative));
    }
  }
  // `.beave/history/` is what makes `doc-restore` possible. Without it the
  // recipient inherits a ledger that lists revisions it cannot bring back, and
  // DOCOP-001's "restore selects a historical revision" is true only for whoever
  // exported. One flat directory of `<ART-ID>-vN.<ext>` files; nothing nested.
  const historyDir = path.join(stateRoot(root), "history");
  if (fs.existsSync(historyDir)) {
    for (const entry of fs.readdirSync(historyDir).sort()) {
      const candidate = path.join(historyDir, entry);
      if (!fs.statSync(candidate).isFile()) continue;
      sources.set(`history/${entry}`, candidate);
    }
  }
  // A deletion marker without its reason is a marker nobody can act on. The
  // recipient reads the folder, so the reason travels with it (L26).
  const reasonsDir = path.join(stateRoot(root), "deletion-reasons");
  if (fs.existsSync(reasonsDir)) {
    for (const entry of fs.readdirSync(reasonsDir).sort()) {
      const candidate = path.join(reasonsDir, entry);
      if (!fs.statSync(candidate).isFile()) continue;
      sources.set(`deletion-reasons/${entry}`, candidate);
    }
  }
  for (const module of state.modules) {
    if (module.evidence && safeProjectRelative(module.evidence)) {
      const source = resolveRecorded(root, module.evidence);
      if (fs.existsSync(source) && fs.statSync(source).isFile()) sources.set(`files/${module.evidence.replaceAll("\\", "/")}`, source);
    }
  }
  /*
   * Built here, before anything is written, so a failure leaves nothing behind.
   * `last_event_id` moves to the origin as well: a state that names an event its
   * own history does not contain is a state `validate` would refuse.
   */
  const sourceHistory = fs.readFileSync(path.join(stateRoot(root), "events.jsonl"), "utf8");
  const sourceLineCount = sourceHistory.split(/\r?\n/).filter(Boolean).length;
  const portableState: any = structuredClone(state);
  // Not the empty string: the schema requires a non-empty root, and a reader who
  // meets this value should be unable to mistake it for a path. The import
  // replaces it with the destination before anything validates it.
  portableState.project.root = "<packaged>";
  const originEvent: any = {
    event_id: crypto.randomUUID(),
    type: "PROJECT_PACKAGE_EXPORTED",
    state_revision: portableState.revision,
    at: now(),
    replay_origin: true,
    format: EVENT_FORMAT,
    source_state_revision: state.revision,
    source_event_count: sourceLineCount,
    source_history_sha256: sha256(sourceHistory),
    source_last_event_id: state.last_event_id ?? null,
  };
  portableState.last_event_id = originEvent.event_id;
  Object.assign(originEvent, {
    previous_revision: Number(portableState.revision) - 1,
    previous_state_sha256: null,
    previous_event_sha256: null,
    state_sha256: digestOf(portableState),
    state_patch: [{ op: "set", path: [], value: structuredClone(portableState) }],
  });
  originEvent.payload_sha256 = digestOf({ ...originEvent, payload_sha256: undefined });
  generated.set("state/state.json", `${JSON.stringify(portableState, null, 2)}${NL}`);
  generated.set("state/events.jsonl", `${JSON.stringify(originEvent)}${NL}`);

  const exportStagingId = crypto.randomUUID();
  openStaging(staging, {
    kind: "export",
    staging_id: exportStagingId,
    operation_id: pendingOperation?.id ?? null,
    source: root,
    destination,
  }, root);
  try {
    stagingPhase(staging, "COPYING");
    let copied = 0;
    const entries: [string, string | null][] = [...[...generated.keys()].map((relative) => [relative, null] as [string, null]), ...sources];
    const files = entries.sort(([a], [b]) => a.localeCompare(b)).map(([relative, source]) => {
      if (source === null) {
        const body = generated.get(relative)!;
        const target = path.join(staging, relative);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, body);
        copied += 1;
        if (relative === "state/state.json") faultPoint("staging-after-state");
        if (relative === "state/events.jsonl") faultPoint("staging-after-events");
        return { path: relative, sha256: sha256(body), bytes: Buffer.byteLength(body) };
      }
      const sourceRelative = path.relative(root, source);
      const confined = existingFileInside(root, sourceRelative);
      if (!safeProjectRelative(relative) || !confined) throw new PlangonautError(`Cannot package missing or unsafe file: ${relative}`);
      // A history entry is one flat filename under `history/`. Anything with a
      // separator in it is not something this format produces.
      if (relative.startsWith("history/") && relative.slice("history/".length).includes("/")) {
        throw new PlangonautError(`Cannot package a nested history entry: ${relative}`);
      }
      copyFileCreatingParents(confined, path.join(staging, relative));
      copied += 1;
      if (copied === 1) faultPoint("staging-during-copy");
      if (relative === "state/state.json") faultPoint("staging-after-state");
      if (relative === "state/events.jsonl") faultPoint("staging-after-events");
      return { path: relative, sha256: sha256(fs.readFileSync(confined)), bytes: fs.statSync(confined).size };
    });
    const entry = `# ${state.project.name}\n\nThis folder is a verified Plangonaut project handoff.\n\n1. Read \`state/state.json\` and \`state/events.jsonl\`.\n2. Read the approved project documents under \`files/\`.\n3. Verify \`manifest.json\` before execution.\n4. Resume from the exact next action recorded in state.\n\nThe project's own entry point, wherever the state names it, takes precedence over this file: this one describes the package, not the project.\n\n\`history/\` holds the recorded document revisions as files. \`plangonaut project-import\` puts them back under \`.beave/history/\`, so \`plangonaut doc-restore\` brings an earlier revision back exactly as it did for whoever exported. \`plangonaut doc-history\` will be **empty** for anything that happened before this package was made: it reads the event log, and the log this package carries begins at the moment of the export (see below). The revisions themselves are here; the account of who wrote each one, when, and from which sources stayed with the exporting project.\n\n## What this package's history is\n\n\`state/events.jsonl\` holds **one** event: the point at which this package was made, carrying the whole project state. Everything the project decided, asked, answered, recorded and published is in \`state/state.json\` and is complete; what is not here is the exporting project's own event-by-event log, because it recorded that project's absolute path on the machine that made it. \`manifest.json\` records the digest of that history, its length and its last event id, so the two can be matched later without either being disclosed.\n`;
    atomicWrite(path.join(staging, "PROJECT_ENTRY.md"), entry);
    files.push({ path: "PROJECT_ENTRY.md", sha256: sha256(entry), bytes: Buffer.byteLength(entry) });
    files.sort((a, b) => a.path.localeCompare(b.path));
    const manifest = {
      format: PACKAGE_FORMAT,
      created_at: now(),
      beave_version: VERSION,
      schema_version: state.schema_version,
      project_name: state.project.name,
      state_revision: state.revision,
      entrypoint: "PROJECT_ENTRY.md",
      // Declared, because a transformation nobody is told about is indistinguishable
      // from a package somebody edited. The digest is of the history this package
      // was made from: it proves which history, and discloses nothing from it.
      history_transform: {
        kind: "portable-replay-origin",
        reason: "The exporting machine's absolute project path is not carried into a handoff.",
        origin_event_id: originEvent.event_id,
        origin_event_type: originEvent.type,
        source_state_revision: state.revision,
        source_event_count: sourceLineCount,
        source_history_sha256: originEvent.source_history_sha256,
        source_last_event_id: originEvent.source_last_event_id,
        replayable_from: "the origin event in state/events.jsonl; the history before it stays with the exporting project and is attested by source_history_sha256, not reproduced here",
      },
      files,
    };
    writeJson(path.join(staging, "manifest.json"), manifest);
    stagingPhase(staging, "MANIFEST", { expected_files: files.length, expected_manifest_sha256: sha256(fs.readFileSync(path.join(staging, "manifest.json"))) });
    faultPoint("staging-after-manifest");
    packageManifest(staging);
    stagingPhase(staging, "VERIFIED");
    faultPoint("staging-after-verify");
    faultPoint("staging-before-rename");
    fs.renameSync(staging, destination);
    faultPoint("staging-after-rename");
    // Removed from the promoted directory, not from the staging: a marker that
    // disappears first can leave a directory nothing recognises. See
    // `resolveAbandonedStagings`.
    fs.rmSync(stagingMarkerPath(destination), { force: true });
  } catch (error) {
    if (fs.existsSync(staging) && path.dirname(staging) === parent) fs.rmSync(staging, { recursive: true, force: true });
    forgetStagingNote(root, exportStagingId);
    throw error;
  }
  faultPoint("staging-before-cleanup");
  forgetStagingNote(root, exportStagingId);
  console.log(`Exported verified project package to ${destination}`);
}

/**
 * Every file actually in the package, relative and with `/` separators.
 *
 * `packageManifest` walks the *manifest*, so it has always caught a missing or
 * changed file and never an extra one — while the contract said it refuses
 * "missing, duplicate, changed or unexpected content". The second review put a
 * rogue file in three different directories and got `Verified` three times.
 */
function packageFilesOnDisk(packageRoot: string): string[] {
  const found: string[] = [];
  const walk = (directory: string, prefix: string) => {
    for (const entry of fs.readdirSync(directory).sort()) {
      const candidate = path.join(directory, entry);
      const relative = prefix ? `${prefix}/${entry}` : entry;
      if (fs.statSync(candidate).isDirectory()) walk(candidate, relative);
      else found.push(relative);
    }
  };
  walk(packageRoot, "");
  return found;
}

/**
 * A staging directory is not a package, and says so in a file.
 *
 * `.beave-staging.json` exists precisely to mark a directory that has not been
 * promoted. Neither `project-verify` nor `project-import` looked at it, so the
 * rule "an interrupted staging is discarded, never promoted" was one command
 * away from being false.
 */
function refuseUnpromotedStaging(directory: string, verb: string): void {
  const marker = readStagingMarker(directory);
  if (!marker) return;
  if (path.resolve(marker.destination) === path.resolve(directory)) return;
  throw new PlangonautError(
    `${path.basename(directory)} is a Plangonaut staging directory, not a package: it carries ${STAGING_MARKER}, which says the ${marker.kind} that was building it never finished (phase ${marker.phase}, started ${marker.created_at}).\n` +
      `Plangonaut will not ${verb} an unfinished package. Re-run the export that was interrupted; nothing was changed.`,
  );
}

/**
 * A package holds what its manifest says it holds, and nothing else.
 *
 * The check lived only in `project-verify`, which is the command a careful
 * recipient runs and not the command that acts. A third independent review put a
 * rogue file in seven positions and got a refusal seven times from
 * `project-verify` and `Imported and resumed …` seven times from
 * `project-import`, followed by `Plangonaut state is valid.` — the trust boundary
 * checked by the advisory command and not by the one that crosses it.
 *
 * The staging marker is the single file allowed to be here undeclared, and only
 * when it names *this* directory as its destination: that is what a crash
 * between the rename and the marker's removal leaves behind. The other case is
 * already refused by `refuseUnpromotedStaging`.
 */
function refuseUndeclaredPackageFiles(packageRoot: string, manifest: any, leftoverMarker: boolean): void {
  const declared = new Set((manifest.files ?? []).map((item: any) => String(item.path)));
  const unexpected = packageFilesOnDisk(packageRoot).filter(
    (relative) => relative !== "manifest.json" && !declared.has(relative) && !(leftoverMarker && relative === STAGING_MARKER),
  );
  if (!unexpected.length) return;
  throw new PlangonautError(
    `The package holds ${unexpected.length} file${unexpected.length === 1 ? "" : "s"} its manifest does not declare: ${unexpected.slice(0, 8).join(", ")}${unexpected.length > 8 ? ", …" : ""}.\n` +
      `A handoff is what the manifest says it is. Something was added after the export, or the export was not made by this engine. Nothing was changed.`,
  );
}

/**
 * The attestation is compared with the thing it attests, by both commands.
 *
 * `history_transform` is what a recipient matches a package against its source
 * by, and nothing checked it against the origin event three files away: a review
 * set the digest to sixty-four zeroes and the count to 9999 and got `Verified`.
 * The event's own bytes are covered by the manifest's file list, so the two can
 * be compared.
 *
 * It lived in `project-verify` alone for one round, which the same review caught
 * on the re-check — and named the reason it matters more here than anywhere:
 * `project-import` writes `package_manifest_sha256` into the destination's event
 * log, so importing a falsified package *notarises* the false attestation in the
 * one place it will be read back later. The check belongs to the command that
 * acts, not only to the one that reports.
 */
function refuseContradictoryAttestation(packageRoot: string, manifest: any): void {
  const declared = manifest?.history_transform;
  const eventsPath = path.join(packageRoot, "state", "events.jsonl");
  const lines = fs.existsSync(eventsPath)
    ? fs.readFileSync(eventsPath, "utf8").split(/\r?\n/).filter(Boolean)
    : [];

  /*
   * The ledger's own bytes, checked here and not two commands later.
   *
   * Every event records `payload_sha256`, a digest of itself, and this engine
   * has verified it since `ALN-011` — but only on replay. So a package whose
   * origin event had been edited, with the manifest's digests repaired to
   * match, was reported `Verified`, imported with exit 0, and produced a project
   * that failed `validate` on the very next command: "the event was edited after
   * it was written". A gate that passes something the engine itself calls
   * tampered is not a gate.
   */
  for (const [index, line] of lines.entries()) {
    let event: any = null;
    try { event = JSON.parse(line); } catch { event = null; }
    if (!event) {
      throw new PlangonautError(`Line ${index + 1} of the package's state/events.jsonl is not JSON. A package whose ledger cannot be read is not a package; nothing was changed.`);
    }
    if (typeof event.payload_sha256 !== "string") continue;
    const recomputed = digestOf({ ...event, payload_sha256: undefined });
    if (recomputed !== event.payload_sha256) {
      throw new PlangonautError(
        `Line ${index + 1} (${event.type ?? "an event"}) of the package's ledger does not match the digest it records of itself. The event was edited after it was written. Nothing was changed.`,
      );
    }
  }

  const first = lines[0] ?? null;
  let origin: any = null;
  try { origin = first ? JSON.parse(first) : null; } catch { origin = null; }

  /*
   * An absent attestation is not a passed check.
   *
   * `if (!declared) return` meant an attacker did not have to falsify the
   * digest, the count or the last event id: deleting the block — or setting it
   * to `null`, `false`, `""` or `0` — was enough, and both commands answered
   * exit 0. The early return existed for packages made before the portable
   * origin, and the version gate for that is in the package itself: a package
   * whose ledger *begins* with a `PROJECT_PACKAGE_EXPORTED` event was made by
   * this format and must declare what it transformed. One made by an older
   * engine begins with the project's own history and declares nothing, which is
   * correct for it.
   */
  if (!declared) {
    if (origin?.type === "PROJECT_PACKAGE_EXPORTED") {
      throw new PlangonautError(
        `This package's ledger begins with a ${origin.type} event, so it was made by an engine that replaces the exporting project's history with a portable origin — and its manifest declares no \`history_transform\` to say what it replaced.\n` +
          `That declaration is the only thing a recipient can match this package against the history it came from, and a package that drops it cannot be told from one that never had it. Nothing was changed.`,
      );
    }
    return;
  }

  if (!origin || origin.type !== declared.origin_event_type || origin.event_id !== declared.origin_event_id) {
    throw new PlangonautError(
      `The manifest declares a history transformation whose origin event is not the first event in state/events.jsonl. The package contradicts itself; nothing was changed.`,
    );
  }
  for (const field of ["source_history_sha256", "source_event_count", "source_last_event_id", "source_state_revision"]) {
    if (String(origin[field] ?? "") !== String(declared[field] ?? "")) {
      throw new PlangonautError(
        `The manifest and the package's own origin event disagree about \`${field}\`: the manifest says ${JSON.stringify(declared[field])} and the event says ${JSON.stringify(origin[field])}.\n` +
          `That field is how this package is matched against the history it was made from, so the disagreement matters. Nothing was changed.`,
      );
    }
  }
}

function projectVerify(flags: Flags): void {
  const packageRoot = resolveProject(required(flags, "package-dir"));
  refuseUnpromotedStaging(packageRoot, "verify");
  const manifest = packageManifest(packageRoot);
  /*
   * A package still carrying its staging marker is refused, not excused.
   *
   * This used to print "It is harmless and is not part of the package" and exit
   * 0. The marker is not harmless: it records the exporting machine's absolute
   * paths, its hostname and the PID of the process that made it — the exact
   * disclosure `ALN-014` exists to prevent, in a file the manifest does not
   * declare, waved through by the one command whose job is to check a package
   * before it is handed to somebody. A fourth independent review planted a
   * marker naming an invented victim's folder and got `Verified`.
   *
   * The way out costs nothing: the export left the package complete, and any
   * command on the exporting project clears the marker.
   */
  if (readStagingMarker(packageRoot) !== null) {
    const marker = readStagingMarker(packageRoot)!;
    throw new PlangonautError(
      `This package carries ${STAGING_MARKER}, left by an export that was interrupted after the package was complete (phase ${marker.phase}, started ${marker.created_at}).\n` +
        `It is not a file the manifest declares and it records the exporting machine — its paths, its hostname, the process that made it — so this package must not be handed to anybody as it stands.\n` +
        `On the machine that exported it: \`plangonaut recover --project-root <the exporting project> --apply\`, or simply run the export again. Either removes it. Nothing was changed here.`,
    );
  }
  refuseUndeclaredPackageFiles(packageRoot, manifest, false);
  refuseContradictoryAttestation(packageRoot, manifest);
  console.log(`Verified project package ${manifest.project_name} at state revision ${manifest.state_revision} (${manifest.files.length} files).`);
}

function projectImport(flags: Flags): void {
  const packageRoot = resolveProject(required(flags, "package-dir"));
  refuseUnpromotedStaging(packageRoot, "import");
  const manifest = packageManifest(packageRoot);
  // The checks `project-verify` makes, made by the command that acts on the
  // answer rather than only by the one that reports it.
  if (readStagingMarker(packageRoot) !== null) {
    throw new PlangonautError(
      `This package carries ${STAGING_MARKER} from an interrupted export, which records the exporting machine's paths, hostname and process id.\n` +
        `Have it cleared where it was made — \`plangonaut recover --project-root <the exporting project> --apply\`, or a re-run of the export — and import the package after that. Nothing was written.`,
    );
  }
  refuseUndeclaredPackageFiles(packageRoot, manifest, false);
  refuseContradictoryAttestation(packageRoot, manifest);
  const root = path.resolve(required(flags, "project-root"));
  const key = idempotencyKey(flags);
  /*
   * The staging resolution runs before the idempotent shortcut, not after.
   *
   * A crash between the rename and the marker's removal leaves a finished
   * project carrying one extra file; the natural retry — same operation id — used
   * to answer `Idempotent retry` and return, so the only command that recognises
   * that marker never reached the code that removes it. The second review found
   * it after the same reasoning had already been applied one line further down.
   */
  for (const note of resolveAbandonedStagings(path.dirname(root), root, null)) console.log(`Recovered: ${note}.`);
  // Through `stateRoot`, not a literal: an import into a legacy project has to
  // find that project's own history, and this was the one path in the file that
  // would have looked in the wrong directory for it.
  if (fs.existsSync(path.join(stateRoot(root), "events.jsonl")) && checkIdempotency(root, key)) return console.log(`Idempotent retry: project import already applied.`);
  const parent = path.dirname(root);
  fs.mkdirSync(parent, { recursive: true });
  if (fs.existsSync(root) && (!fs.statSync(root).isDirectory() || fs.readdirSync(root).length)) throw new PlangonautError(`Import destination must be a new or empty directory: ${root}`);
  const staging = path.join(parent, `.${path.basename(root)}.${crypto.randomUUID()}.tmp`);
  const destinationExisted = fs.existsSync(root);
  let projectName = manifest.project_name;
  // The staging directory has to exist before the first entry is placed, not as a
  // side effect of whichever entry happens to sort first. It used to be created
  // by `copyFileCreatingParents` on the `files/` branch, which worked only while
  // `files/` sorted ahead of everything else: adding `deletion-reasons/` put a `d`
  // in front of that `f` and every import of a package carrying a deletion reason
  // failed on `realpath` of a directory nobody had made yet.
  openStaging(staging, {
    kind: "import",
    staging_id: crypto.randomUUID(),
    operation_id: pendingOperation?.id ?? null,
    source: packageRoot,
    destination: root,
  });
  try {
    stagingPhase(staging, "COPYING");
    let copiedIn = 0;
    for (const item of manifest.files) {
      if (item.path.startsWith("files/")) copyFileCreatingParents(path.join(packageRoot, item.path), path.join(staging, item.path.slice("files/".length)));
      else if (item.path === "state/state.json") copyFileCreatingParents(path.join(packageRoot, item.path), path.join(stateRoot(staging), "state.json"));
      else if (item.path === "state/events.jsonl") copyFileCreatingParents(path.join(packageRoot, item.path), path.join(stateRoot(staging), "events.jsonl"));
      else if (item.path.startsWith("history/")) copyFileCreatingParents(path.join(packageRoot, item.path), path.join(stateRoot(staging), "history", item.path.slice("history/".length)));
      else if (item.path.startsWith("deletion-reasons/")) copyFileCreatingParents(path.join(packageRoot, item.path), path.join(stateRoot(staging), "deletion-reasons", item.path.slice("deletion-reasons/".length)));
      copiedIn += 1;
      if (copiedIn === 1) faultPoint("staging-during-copy");
      if (item.path === "state/state.json") faultPoint("staging-after-state");
      if (item.path === "state/events.jsonl") faultPoint("staging-after-events");
    }
    faultPoint("staging-after-manifest");
    const stagedState = readJson(path.join(stateRoot(staging), "state.json")) as State;
    stagedState.project.root = staging;
    const stagedErrors = stateErrors(staging, stagedState);
    if (!stagedErrors.length) stagedErrors.push(...documentIntegrityErrors(staging, stagedState));
    if (stagedErrors.length) throw new PlangonautError(`Imported package state failed validation:\n- ${stagedErrors.join("\n- ")}`);

    const timestamp = now();
    const eventId = crypto.randomUUID();
    stagedState.revision += 1;
    stagedState.last_event_id = eventId;
    stagedState.updated_at = timestamp;
    /*
     * The import is a replay origin, and it has to be one.
     *
     * The package carries the exporter's events verbatim, and the destination
     * rewrites `project.root` — a change to the state that no event in that file
     * describes, because it happens to the copy rather than to the project. So a
     * replay of the imported history from the exporter's own beginning would
     * rebuild a state pointing at the exporter's folder. Recording the import as
     * an origin says the true thing: everything from the moment this folder came
     * into existence is reproducible, and the history that arrived with it is
     * kept, readable, and outside that proof.
     */
    const event: any = { event_id: eventId, type: "PROJECT_PACKAGE_IMPORTED", state_revision: stagedState.revision, at: timestamp, source_state_revision: manifest.state_revision, package_manifest_sha256: sha256(fs.readFileSync(path.join(packageRoot, "manifest.json"))), idempotency_key: key, replay_origin: true, operation_id: pendingOperation!.id, operation_payload_hash: pendingOperation!.payloadHash, operation_payload_version: pendingOperation!.payloadVersion };

    const validationState = structuredClone(stagedState);
    validationState.project.root = staging;
    const finalErrors = stateErrors(staging, validationState, event);
    if (!finalErrors.length) finalErrors.push(...documentIntegrityErrors(staging, validationState));
    if (finalErrors.length) throw new PlangonautError(`Final imported project failed validation:\n- ${finalErrors.join("\n- ")}`);

    stagingPhase(staging, "VERIFIED");
    faultPoint("staging-after-verify");
    stagedState.project.root = root;
    // The same fields `commitState` would attach, because the destination is not
    // a project yet and the promotion is a directory rename rather than a write
    // into a live one. The patch is the whole state, which is what an origin is.
    const stagedTail = lastEventLine(staging);
    Object.assign(event, {
      format: EVENT_FORMAT,
      previous_revision: Number(stagedState.revision) - 1,
      previous_state_sha256: null,
      state_sha256: digestOf(stagedState),
      state_patch: [{ op: "set", path: [], value: structuredClone(stagedState) }],
      previous_event_sha256: stagedTail ? sha256(stagedTail.line) : null,
    });
    event.payload_sha256 = digestOf({ ...event, payload_sha256: undefined });
    writeJson(path.join(stateRoot(staging), "state.json"), stagedState);
    appendEvent(staging, event);
    /*
     * The derived document is written into the staging, not into the promoted
     * folder.
     *
     * It used to be written after the rename, which left a window: a crash in it
     * produced a project whose state recorded a digest for a document that was
     * not there, and `validate` refused it. Writing it before the rename closes
     * the window by construction -- the directory that appears is complete.
     */
    if (Array.isArray(stagedState.interview_log)) writeInterviewView(staging, renderInterviewView(stagedState));
    stagingPhase(staging, "PROMOTING");
    faultPoint("staging-before-rename");
    if (destinationExisted) fs.rmdirSync(root);
    fs.renameSync(staging, root);
    faultPoint("staging-after-rename");
    fs.rmSync(stagingMarkerPath(root), { force: true });
    /*
     * The history document is regenerated here, not shipped in the package.
     *
     * It is derived: the ledger travels in `state/`, and a derived file in a
     * handoff would be a second copy to keep in step and to verify. Regenerating
     * it at the destination also repairs a package produced before this ledger
     * existed, which carries no such file and needs none.
     *
     * Before `validateRoot`, because that check now includes the document, and
     * the first import after this feature landed failed exactly here — the state
     * recorded a digest and the folder had no file to match it.
     */
    validateRoot(root, true);
    projectName = stagedState.project.name;
  } catch (error) {
    if (fs.existsSync(staging) && path.dirname(staging) === parent) fs.rmSync(staging, { recursive: true, force: true });
    if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
    if (destinationExisted) fs.mkdirSync(root, { recursive: true });
    throw error;
  }
  faultPoint("staging-before-cleanup");
  console.log(`Imported and resumed ${projectName} at ${root}`);
}

/**
 * Rewrite `\` to `/` in every persisted relative path, and report what changed.
 *
 * Returns one entry per substitution — the field, the sentence before, the
 * sentence after — so the caller can put all of it in the event. Nothing is
 * touched on disk and no digest is recomputed: the bytes a digest describes do
 * not depend on how the path to them is spelled.
 */
function normalizeRecordedSeparators(state: any): Array<{ field: string; before: string; after: string }> {
  const rewrites: Array<{ field: string; before: string; after: string }> = [];
  const rewrite = (holder: any, key: string, field: string) => {
    const before = holder?.[key];
    if (typeof before !== "string" || !before.includes("\\")) return;
    const after = canonicalRelative(before);
    holder[key] = after;
    rewrites.push({ field, before, after });
  };
  (state.modules ?? []).forEach((item: any) => rewrite(item, "evidence", `modules[${item?.id}].evidence`));
  (state.evidence ?? []).forEach((item: any) => rewrite(item, "path", `evidence[${item?.id}].path`));
  (state.artifacts ?? []).forEach((item: any) => {
    rewrite(item, "base_path", `artifacts[${item?.id}].base_path`);
    rewrite(item, "working_path", `artifacts[${item?.id}].working_path`);
  });
  (state.gates ?? []).forEach((item: any) => {
    rewrite(item, "evidence", `gates[${item?.name || item?.id}].evidence`);
    (item?.source_history ?? []).forEach((entry: any, index: number) => rewrite(entry, "path", `gates[${item?.name || item?.id}].source_history[${index}].path`));
  });
  (state.human_overrides ?? []).forEach((item: any) => {
    rewrite(item, "source", `human_overrides[${item?.id}].source`);
    rewrite(item, "reconciliation_evidence", `human_overrides[${item?.id}].reconciliation_evidence`);
    (item?.source_history ?? []).forEach((entry: any, index: number) => rewrite(entry, "path", `human_overrides[${item?.id}].source_history[${index}].path`));
  });
  return rewrites;
}

function migrate(flags: Flags): void {
  const root = resolveProject(required(flags, "project-root"));
  const key = idempotencyKey(flags);
  if (checkIdempotency(root, key)) return console.log(`Idempotent retry: migration already applied.`);
  const location = path.join(stateRoot(root), "state.json");
  const rawState = readJson(location);
  
  if (rawState.schema_version === SCHEMA_VERSION) {
    // Blocker 4. A state already on the current schema can still carry relative
    // paths spelled `docs\plan.md`, because that is what `path.relative` returned
    // on Windows before the rule existed. Every reader accepts both spellings, so
    // nothing is broken and nothing is rewritten behind anyone's back: this is the
    // explicit, governed normalisation, and it records every single substitution
    // in the event so the provenance of a historic record is not lost by making it
    // look as though it had been born clean.
    const rewrites = normalizeRecordedSeparators(rawState);
    /*
     * A project created before the interview ledger existed gets an empty one,
     * and a marker saying when recording began.
     *
     * Nothing is reconstructed. The marker is the whole point: without it, an
     * empty history reads as "no question was ever asked", which is false and is
     * exactly the inference the brief forbids. With it, Resume can say that the
     * project predates the ledger and that earlier interactions were not
     * recorded — a different statement, and the true one.
     */
    const needsLedger = !Array.isArray(rawState.interview_log);
    if (!rewrites.length && !needsLedger) return console.log(`State already uses schema version ${SCHEMA_VERSION}, every recorded relative path already uses "/", and the interview ledger is present.`);
    const revision = Number(rawState.revision || 0) + 1;
    const eventId = crypto.randomUUID();
    const at = now();
    if (needsLedger) {
      rawState.interview_log = [];
      rawState.interview_log_since = at;
      rawState.interview_view = null;
    }
    Object.assign(rawState, { revision, last_event_id: eventId, updated_at: at });
    const renderedView = needsLedger ? stampInterviewView(rawState) : null;
    const event = { event_id: eventId, type: needsLedger ? "INTERVIEW_LEDGER_OPENED" : "RECORDED_PATHS_NORMALIZED", state_revision: revision, at, idempotency_key: key, separator: "/", rewrites, interview_log_since: needsLedger ? at : undefined };
    const transaction = beginFileTransaction(root, event, renderedView === null ? [] : [path.join(root, QA_VIEW_RELATIVE)]);
    try {
      commitState(root, location, rawState, event, { views: renderedView !== null });
      if (renderedView !== null) writeInterviewView(root, renderedView);
      faultPoint("after-view");
      completeFileTransaction(transaction);
    } catch (error) {
      if (fs.existsSync(transaction)) rollbackFileTransaction(root, transaction);
      throw error;
    }
    if (renderedView !== null) {
      console.log(`Opened the interview ledger for this project. Nothing before ${at} was recorded, and nothing has been reconstructed: ${QA_VIEW_RELATIVE} says so.`);
    }
    if (!rewrites.length) return;
    console.log(`Normalized ${rewrites.length} recorded path${rewrites.length === 1 ? "" : "s"} to "/" as the separator.`);
    for (const rewrite of rewrites) console.log(`  ${rewrite.field}: ${rewrite.before} -> ${rewrite.after}`);
    console.log(`No digest was recomputed and no file was touched: only the spelling of the path changed. Every substitution is recorded verbatim in event ${eventId}.`);
    return;
  }

  if (rawState.schema_version !== 1 && rawState.schema_version !== 2) {
    throw new PlangonautError(`No migration path from schema_version=${rawState.schema_version}`);
  }

  const fromSchema = rawState.schema_version;
  const legacy = rawState.interaction_mode;
  rawState.interaction_mode = ({ Batch: "Standard", "Brief-led": "Standard" } as any)[legacy] ?? legacy;
  if (!INTERACTION_MODES.has(rawState.interaction_mode)) throw new PlangonautError(`Unknown legacy interaction mode: ${legacy}`);
  
  const revision = Number(rawState.revision || 0) + 1;
  const eventId = crypto.randomUUID();

  // V2 -> V3 array initialization
  if (rawState.schema_version <= 2) {
    rawState.decisions = rawState.decisions || [];
    rawState.requirements = rawState.requirements || [];
    rawState.artifacts = rawState.artifacts || [];
    rawState.tasks = rawState.tasks || [];
    rawState.dependencies = rawState.dependencies || [];
    rawState.gates = rawState.gates || [];
    rawState.risks_legacy = rawState.risks || [];
    rawState.evidence_legacy = rawState.evidence || [];
    
    // reset real v3 arrays for evidence and risks since types changed from string[] to object[]
    rawState.risks = [];
    rawState.evidence = [];
    
    rawState.agents = rawState.agents || [];
    rawState.operations = rawState.operations || [];
    rawState.checkpoints = rawState.checkpoints || [];

    // D5. The history gets an empty array so a migrated project has somewhere to
    // put its first forecast. `progress_forecast` is deliberately NOT created: an
    // empty or zeroed forecast would be a measurement nobody made, which is the
    // failure FR-024 names. A migrated project has never recorded one, and says so.
    rawState.forecast_history = rawState.forecast_history || [];
  }

  Object.assign(rawState, { schema_version: SCHEMA_VERSION, beave_version: VERSION, intake_strategy: legacy === "Brief-led" ? "Brief-led" : "Adaptive", human_overrides: rawState.human_overrides || [], needs_reconciliation: Boolean(rawState.needs_reconciliation), revision, last_event_id: eventId, updated_at: now() });
  // Blocker 4, on the schema path too: a v1/v2 ledger written on Windows carries
  // the same `\` spellings, and each substitution is recorded in the event.
  const rewrites = normalizeRecordedSeparators(rawState);
  const event = { event_id: eventId, type: "STATE_MIGRATED", state_revision: revision, at: rawState.updated_at, from_schema: fromSchema, to_schema: SCHEMA_VERSION, legacy_interaction_mode: legacy, idempotency_key: key, separator: "/", path_rewrites: rewrites };
  commitState(root, location, rawState, event);
  console.log(`Migrated Plangonaut state to schema ${SCHEMA_VERSION}.`);
}

function historyLocation(root: string, artifact: Artifact, revision: number): string {
  return path.join(stateRoot(root), "history", `${artifact.id}-v${revision}${path.parse(artifact.base_path).ext}`);
}

// Every digest Plangonaut has ever produced for this artifact: the hashes recorded in
// the ledger plus whatever is preserved under `.beave/history/`. Content matching
// one of them is a Plangonaut publication and may be replaced; anything else is content
// Plangonaut never wrote, and overwriting it is irreversible because `.beave/backups/`
// only ever holds state.json and events.jsonl, never document bytes.
function recordedDigests(root: string, artifactId: string): Set<string> {
  const digests = new Set<string>();
  const eventsFile = path.join(stateRoot(root), "events.jsonl");
  if (fs.existsSync(eventsFile)) {
    for (const line of fs.readFileSync(eventsFile, "utf8").split(/\r?\n/).filter(Boolean)) {
      let event: any;
      try { event = JSON.parse(line); } catch { continue; }
      if (event.artifact_id === artifactId && typeof event.hash === "string") digests.add(event.hash);
    }
  }
  const historyDir = path.join(stateRoot(root), "history");
  if (fs.existsSync(historyDir)) {
    for (const entry of fs.readdirSync(historyDir)) {
      if (!entry.startsWith(`${artifactId}-`)) continue;
      if (!/^(v\d+|external-)/.test(entry.slice(artifactId.length + 1))) continue;
      digests.add(sha256(fs.readFileSync(path.join(historyDir, entry), "utf8")));
    }
  }
  return digests;
}

// DOCOP-001, "Locks": external editors are not locked, so every write revalidates
// the filesystem hash. Any command that consumes the current working file must
// call this first, otherwise a manual edit is swallowed without a trace.
function assertNoExternalEdit(root: string, artifact: Artifact): void {
  if (!artifact.working_path) return;
  const current = resolveRecorded(root, artifact.working_path);
  if (!fs.existsSync(current)) return;
  if (sha256(fs.readFileSync(current, "utf8")) !== artifact.content_hash) {
    throw new PlangonautError(`External edit detected on ${artifact.working_path}. Hashes do not match. Reconcile manually.`);
  }
}

// DOCOP-001, "History and restore" / "Finalization": restore does not delete
// intervening history and finalization keeps all internal history. Archiving the
// current revision therefore obeys two hard rules:
//   1. a PUBLISHED base file is COPIED, never moved. After doc-finalize
//      working_path === base_path, so moving it would silently unpublish the
//      document while state.json still reports PUBLISHED.
//   2. an existing history entry is never replaced by different bytes, so an
//      authentic revision can never be destroyed by drifted or tampered content.
function archiveCurrentRevision(root: string, artifact: Artifact): void {
  if (!artifact.working_path) return;
  const current = resolveRecorded(root, artifact.working_path);
  if (!fs.existsSync(current)) return;
  const target = historyLocation(root, artifact, artifact.revision);
  const publishedBase = artifact.working_path === artifact.base_path;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.existsSync(target)) {
    if (sha256(fs.readFileSync(target)) !== sha256(fs.readFileSync(current))) {
      throw new PlangonautError(`History for ${artifact.id} revision ${artifact.revision} already exists with different content at ${path.relative(root, target).replaceAll("\\", "/")}. Refusing to overwrite recorded history.`);
    }
    if (!publishedBase) fs.rmSync(current);
    return;
  }
  if (publishedBase) fs.copyFileSync(current, target);
  else fs.renameSync(current, target);
}

// The ledger already records the hash of every saved and restored revision, but
// nothing ever compared it with the bytes on disk: damage was provable and never
// proved. `plangonaut validate` now performs that comparison.
function documentIntegrityErrors(root: string, state: State): string[] {
  const errors: string[] = [];
  if (!Array.isArray(state.artifacts) || !state.artifacts.length) return errors;
  const recorded = new Map<string, string>();
  const eventsFile = path.join(stateRoot(root), "events.jsonl");
  if (fs.existsSync(eventsFile)) {
    for (const line of fs.readFileSync(eventsFile, "utf8").split(/\r?\n/).filter(Boolean)) {
      let event: any;
      try { event = JSON.parse(line); } catch { continue; }
      if (!event.artifact_id || typeof event.hash !== "string") continue;
      const revision = event.type === "DOCUMENT_RESTORED" ? event.new_revision : event.revision;
      if (Number.isInteger(revision)) recorded.set(`${event.artifact_id}@${revision}`, event.hash);
    }
  }
  for (const artifact of state.artifacts) {
    for (const [reference, expected] of recorded) {
      const separator = reference.lastIndexOf("@");
      if (reference.slice(0, separator) !== artifact.id) continue;
      const revision = Number(reference.slice(separator + 1));
      const location = historyLocation(root, artifact, revision);
      if (!fs.existsSync(location)) continue;
      if (sha256(fs.readFileSync(location, "utf8")) !== expected) {
        errors.push(`Refusing to overwrite recorded history: history file for ${artifact.id} revision ${revision} does not match the hash recorded in the ledger`);
      }
    }
    if (artifact.working_path) {
      const current = resolveRecorded(root, artifact.working_path);
      if (!fs.existsSync(current)) errors.push(`working file ${artifact.working_path} for ${artifact.id} is missing`);
      else if (sha256(fs.readFileSync(current, "utf8")) !== artifact.content_hash) errors.push(`External edit detected: working file ${artifact.working_path} for ${artifact.id} was edited outside Plangonaut`);
    }
    if (artifact.status === "PUBLISHED" && !fs.existsSync(resolveRecorded(root, artifact.base_path))) {
      errors.push(`${artifact.id} is recorded as PUBLISHED but ${artifact.base_path} does not exist`);
    }
  }
  return errors;
}

function diffLines(before: string, after: string): Array<{ kind: string; text: string }> {
  const lines = (value: string) => {
    if (!value) return [] as string[];
    const result = value.split(/\r?\n/);
    if (result.at(-1) === "") result.pop();
    return result;
  };
  const oldLines = lines(before);
  const newLines = lines(after);
  if (oldLines.length > 4000 || newLines.length > 4000) return [{ kind: "info", text: `${oldLines.length} lines replaced by ${newLines.length} lines (file too large for a line-by-line preview)` }];
  const table = Array.from({ length: oldLines.length + 1 }, () => new Uint32Array(newLines.length + 1));
  for (let i = oldLines.length - 1; i >= 0; i -= 1) for (let j = newLines.length - 1; j >= 0; j -= 1) table[i][j] = oldLines[i] === newLines[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  const result: Array<{ kind: string; text: string }> = [];
  let i = 0, j = 0;
  while (i < oldLines.length && j < newLines.length) {
    if (oldLines[i] === newLines[j]) { result.push({ kind: "context", text: oldLines[i] }); i += 1; j += 1; }
    else if (table[i + 1][j] >= table[i][j + 1]) { result.push({ kind: "removed", text: oldLines[i] }); i += 1; }
    else { result.push({ kind: "added", text: newLines[j] }); j += 1; }
  }
  while (i < oldLines.length) result.push({ kind: "removed", text: oldLines[i++] });
  while (j < newLines.length) result.push({ kind: "added", text: newLines[j++] });
  return result;
}

function expectedArtifactErrors(flags: Flags, artifact?: Artifact): string[] {
  const revisionFlag = flags["expected-revision"];
  const hashFlag = flags["expected-hash"];
  if (revisionFlag === undefined && hashFlag === undefined) return [];
  if (typeof revisionFlag !== "string" || typeof hashFlag !== "string") return ["--expected-revision and --expected-hash must be supplied together"];
  const expectedRevision = Number(revisionFlag);
  const actualRevision = artifact?.revision ?? 0;
  const actualHash = artifact?.content_hash || "NEW";
  const errors: string[] = [];
  if (!Number.isInteger(expectedRevision) || expectedRevision !== actualRevision) errors.push(`stale revision: expected ${actualRevision}, received ${revisionFlag}`);
  if (hashFlag !== actualHash) errors.push(`stale hash: expected ${actualHash}, received ${hashFlag}`);
  return errors;
}

function previewConfirmationToken(id: string, basePath: string, owner: string, currentRevision: number, currentHash: string, nextHash: string): string {
  return sha256(JSON.stringify({ artifact_id: id, base_path: basePath.replaceAll("\\", "/"), owner, current_revision: currentRevision, current_hash: currentHash, next_hash: nextHash }));
}

function documentPreview(root: string, state: State, flags: Flags): any {
  const id = required(flags, "id").toUpperCase();
  // Blocker 4. `/` is the canonical separator for every persisted relative path,
  // so `docs\plan.md` and `docs/plan.md` name the same artifact and the ledger
  // records the portable spelling. The confirmation token already hashed the
  // canonical form, so no token changes.
  const basePath = canonicalRelative(required(flags, "base-path"));
  const owner = required(flags, "owner");
  const proposed = fs.readFileSync(path.resolve(required(flags, "content-file")), "utf8");
  const artifact = state.artifacts.find((item) => item.id === id);
  const blockers = expectedArtifactErrors(flags, artifact);
  // A path the save cannot accept must not preview cleanly. `stateErrors` rejects
  // an unsafe `base_path` at commit time, so the save was refused either way —
  // but only after the user had reviewed a diff and confirmed it.
  if (!safeArtifactPath(basePath)) blockers.push(`Artifact path must stay inside the project and outside the reserved .plangonaut directory: ${basePath}`);
  let current = "";
  if (artifact) {
    if (!sameRecordedPath(artifact.base_path, basePath)) blockers.push(`Artifact ${id} base_path mismatch. Expected ${artifact.base_path}`);
    {
      const reading = readDocumentLock(artifact, { owner });
      if (reading.state !== "FREE" && reading.owner !== owner) {
        blockers.push(`Artifact ${id} is locked by ${reading.owner} (${reading.state}). ${reading.because}`);
      }
    }
    try { assertNoExternalEdit(root, artifact); } catch (error: any) { blockers.push(error.message); }
    const currentPath = artifact.working_path && resolveRecorded(root, artifact.working_path);
    if (currentPath && fs.existsSync(currentPath)) current = fs.readFileSync(currentPath, "utf8");
  }
  const currentRevision = artifact?.revision ?? 0;
  const currentHash = artifact?.content_hash || "NEW";
  const nextHash = sha256(proposed);
  // A refused preview hands out no confirmation.
  //
  // The token is derived from the artifact's identity and digests, which are the
  // same whether or not the preview found blockers — so a preview reporting
  // "stale revision" returned a token byte-identical to a clean one, and
  // `doc-save` accepted it. Reproduced on 2026-09-10 during the ALN-005 pilots:
  // two previews of the same content, one blocked and one not, returned the same
  // token, and the blocked one's token applied the save. The remaining guards
  // (lock, base path, external edit) do re-run at save time, so nothing could be
  // lost through it; what was wrong is that a confirmation attested to a review
  // the engine had just refused.
  const confirmationToken = blockers.length ? "" : previewConfirmationToken(id, basePath, owner, currentRevision, currentHash, nextHash);
  return { artifact_id: id, base_path: basePath, known: Boolean(artifact), current_revision: currentRevision, next_revision: currentRevision + 1, current_hash: currentHash, next_hash: nextHash, confirmation_token: confirmationToken, unchanged: current === proposed, blockers, diff: diffLines(current, proposed) };
}

function docDiff(flags: Flags): void {
  const root = resolveProject(required(flags, "project-root"));
  const state = validateRoot(root, true);
  console.log(JSON.stringify(documentPreview(root, state, flags), null, 2));
}

function matchingDeletionIntents(root: string, artifactId: string, candidateHash: string, sourceRevision: number, sourceHash: string): string[] {
  const eventsFile = path.join(stateRoot(root), "events.jsonl");
  if (!fs.existsSync(eventsFile)) return [];
  const events = fs.readFileSync(eventsFile, "utf8").split(/\r?\n/).filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
  const consumed = new Set(events.flatMap((event) => event.type === "DOCUMENT_SAVED" && Array.isArray(event.deletion_intent_ids) ? event.deletion_intent_ids : []));
  return events.flatMap((event) => event.type === "DOCUMENT_DELETION_INTENT_RECORDED" && event.artifact_id === artifactId && event.candidate_hash === candidateHash && event.artifact_revision === sourceRevision && event.artifact_hash === sourceHash && !consumed.has(event.deletion_intent_id) ? [event.deletion_intent_id] : []);
}

/**
 * Where a deletion reason is kept so that whoever receives the folder can read it.
 *
 * Content-addressed, which makes it immutable by construction: the same reason is
 * the same file, and a file that already exists is already correct. `reason_path`
 * in the event says where the author happened to write it; this says where it can
 * be read (L26).
 */
function deletionReasonArchive(root: string, digest: string): { absolute: string; relative: string } {
  return {
    absolute: path.join(stateRoot(root), "deletion-reasons", `${digest}.md`),
    relative: `deletion-reasons/${digest}.md`,
  };
}

function docMarkDeletion(flags: Flags): void {
  const root = resolveProject(required(flags, "project-root"));
  const key = idempotencyKey(flags);
  if (checkIdempotency(root, key)) return console.log(`Idempotent retry: doc-mark-deletion already applied.`);
  const state = validateRoot(root, true);
  const location = path.join(stateRoot(root), "state.json");
  assertNotBlocked(state);
  const id = required(flags, "id").toUpperCase();
  const owner = required(flags, "owner");
  const artifact = state.artifacts.find((item) => item.id === id);
  if (!artifact) throw new PlangonautError(`Artifact ${id} not found.`);
  {
    /*
     * The refusal that stranded a real document.
     *
     * It said who held the lock and stopped there, so the reader had nothing to
     * do next: the holder was a Studio session that had closed weeks earlier
     * and the suggestion in circulation - reopen Studio, close the document,
     * quit - could not work, because closing a tab never released anything.
     * The sentence now says what kind of lock it is, how that was established,
     * and which of the three roads out applies.
     */
    const reading = readDocumentLock(artifact, { owner });
    if (reading.state !== "FREE" && reading.owner !== owner) {
      throw new PlangonautError(documentLockRefusal(reading, owner), "PROJECT_STATE_UNTRUSTED");
    }
  }
  assertNoExternalEdit(root, artifact);
  const stale = expectedArtifactErrors(flags, artifact);
  if (stale.length) throw new PlangonautError(`Deletion intent refused:\n- ${stale.join("\n- ")}\nNo changes written.`);
  const target = required(flags, "target").trim();
  if (!target) throw new PlangonautError(`--target cannot be empty`);
  const reasonPath = path.resolve(required(flags, "reason-file"));
  const reasonRelative = path.relative(root, reasonPath);
  const confinedReason = existingFileInside(root, reasonRelative);
  if (!confinedReason) throw new PlangonautError(`Deletion reason must be an existing file inside the project root`);
  const reason = fs.readFileSync(confinedReason);
  if (!reason.length || !reason.toString("utf8").trim()) throw new PlangonautError(`Deletion reason cannot be empty`);
  const candidatePath = path.resolve(required(flags, "content-file"));
  const candidate = fs.readFileSync(candidatePath, "utf8");
  const candidateHash = sha256(candidate);
  const timestamp = now();
  const eventId = crypto.randomUUID();
  const deletionIntentId = `DEL-${crypto.randomBytes(6).toString("hex")}`;
  state.revision += 1;
  state.last_event_id = eventId;
  state.updated_at = timestamp;
  const reasonDigest = sha256(reason);
  const archive = deletionReasonArchive(root, reasonDigest);
  const event = { event_id: eventId, type: "DOCUMENT_DELETION_INTENT_RECORDED", state_revision: state.revision, at: timestamp, idempotency_key: key, deletion_intent_id: deletionIntentId, artifact_id: id, artifact_revision: artifact.revision, artifact_hash: artifact.content_hash, candidate_hash: candidateHash, target, reason_path: reasonRelative.replaceAll("\\", "/"), reason_sha256: reasonDigest, reason_archive_path: archive.relative, owner };
  // The copy goes in before the marker that points at it, inside the same
  // transaction: an interrupted operation must not leave a marker whose reason
  // was never stored, nor a reason no marker refers to.
  const transaction = beginFileTransaction(root, event, [archive.absolute]);
  try {
    if (!fs.existsSync(archive.absolute)) {
      fs.mkdirSync(path.dirname(archive.absolute), { recursive: true });
      atomicWrite(archive.absolute, reason.toString("utf8"));
    }
    commitState(root, location, state, event);
    completeFileTransaction(transaction);
  } catch (error) {
    if (fs.existsSync(transaction)) rollbackFileTransaction(root, transaction);
    throw error;
  }
  console.log(`Recorded deletion intent ${deletionIntentId} for ${id}; no document bytes were deleted. The reason is kept at .beave/${archive.relative}.`);
}

function docSave(flags: Flags): void {
  const root = resolveProject(required(flags, "project-root"));
  const key = idempotencyKey(flags);
  if (checkIdempotency(root, key)) {
    /*
     * A retry answers in the same language as the first attempt.
     *
     * Everything else `doc-save` prints is JSON, and a delegating writer parses
     * it. One prose line on the idempotent path meant a retry — the ordinary
     * consequence of a lost reply — came back unparseable, and a caller that
     * could not read "this already happened" has to treat a success as a
     * failure. The flag is accepted rather than needed because the rest of the
     * output was already machine-readable; it changes this line only.
     */
    return say(flags, `Idempotent retry: doc-save already applied.`, {
      result: "idempotent", command: "doc-save",
    });
  }
  const state = validateRoot(root, true);
  const location = path.join(stateRoot(root), "state.json");
  assertNotBlocked(state);
  
  const id = required(flags, "id").toUpperCase();
  // Blocker 4. `/` is the canonical separator for every persisted relative path,
  // so `docs\plan.md` and `docs/plan.md` name the same artifact and the ledger
  // records the portable spelling. The confirmation token already hashed the
  // canonical form, so no token changes.
  const basePath = canonicalRelative(required(flags, "base-path"));
  const owner = required(flags, "owner");
  const contentPath = path.resolve(required(flags, "content-file"));
  const sources = flags.sources ? String(flags.sources).split(",").map(s => s.trim().toUpperCase()).filter(Boolean) : [];
  
  const content = fs.readFileSync(contentPath, "utf8");
  const hash = sha256(content);
  
  let artifact = state.artifacts.find(a => a.id === id);
  const priorArtifact = artifact ? { ...artifact, provenance: [...(artifact.provenance ?? [])] } : null;
  const sourceRevision = artifact?.revision ?? 0;
  const sourceHash = artifact?.content_hash || "NEW";
  // Substantive refusals come first, deliberately.
  //
  // The confirmation check used to run before the lock and base-path checks, so
  // a save on a document another operation holds was refused with "run doc-diff
  // and pass its confirmation_token" — true, useless, and pointing at the wrong
  // problem. Now that a refused preview withholds its token, that ordering would
  // have replaced every actionable refusal with the token message. The invariant
  // is unchanged: no save is applied without a matching confirmation. Only the
  // order in which the user is told what is wrong has changed.
  if (artifact) {
    if (!sameRecordedPath(artifact.base_path, basePath)) throw new PlangonautError(`Artifact ${id} base_path mismatch. Expected ${artifact.base_path}`);
    {
    /*
     * The refusal that stranded a real document.
     *
     * It said who held the lock and stopped there, so the reader had nothing to
     * do next: the holder was a Studio session that had closed weeks earlier
     * and the suggestion in circulation - reopen Studio, close the document,
     * quit - could not work, because closing a tab never released anything.
     * The sentence now says what kind of lock it is, how that was established,
     * and which of the three roads out applies.
     */
    const reading = readDocumentLock(artifact, { owner });
    if (reading.state !== "FREE" && reading.owner !== owner) {
      throw new PlangonautError(documentLockRefusal(reading, owner), "PROJECT_STATE_UNTRUSTED");
    }
  }
    assertNoExternalEdit(root, artifact);
  }
  const stale = expectedArtifactErrors(flags, artifact);
  if (stale.length) throw new PlangonautError(`Document save refused:\n- ${stale.join("\n- ")}\nNo changes written.`);
  const expectedToken = previewConfirmationToken(id, basePath, owner, sourceRevision, sourceHash, hash);
  if (flags["confirm-token"] !== expectedToken) {
    // The refusal names the command that produces what is missing, with this
    // save's own arguments already in it. The pilot's agent met this message
    // without them, guessed `--confirm`, and was refused a second time.
    const why = typeof flags["confirm-token"] === "string" && flags["confirm-token"]
      ? `The token supplied does not match this change. A token is bound to the artifact, the base path, the owner, the artifact's revision and the content on both sides, so one of those has moved since it was issued.`
      : `No --confirm-token was supplied, and it is required: it is how the engine knows this exact change was previewed.`;
    throw new PlangonautError(
      `Document save refused. ${why}\n\n` +
      `Run this, and pass the confirmation_token it prints:\n` +
      `  plangonaut doc-diff --project-root ${flags["project-root"] ?? "."} --id ${id} --base-path ${basePath} --content-file ${flags["content-file"]} --owner ${owner}\n\n` +
      `Full flow: plangonaut doc-save --help\n` +
      `No changes written.`
    );
  }
  const diff = documentPreview(root, state, { ...flags, id }).diff;
  if (!artifact) {
    artifact = {
      id,
      base_path: basePath,
      working_path: "",
      status: "DRAFT",
      revision: 0,
      content_hash: "",
      // A new artifact is created unlocked. See the note on the update path.
      lock_owner: "",
      provenance: sources
    };
    state.artifacts.push(artifact);
  } else {
    if (!sameRecordedPath(artifact.base_path, basePath)) {
      throw new PlangonautError(`Artifact ${id} base_path mismatch. Expected ${artifact.base_path}`);
    }
    {
      const reading = readDocumentLock(artifact, { owner });
      if (reading.state !== "FREE" && reading.owner !== owner) {
        throw new PlangonautError(documentLockRefusal(reading, owner), "PROJECT_STATE_UNTRUSTED");
      }
    }
    assertNoExternalEdit(root, artifact);
  }
  
  const newRevision = artifact.revision + 1;
  const parsedPath = path.parse(basePath);
  const newWorkingPath = path.posix.join(parsedPath.dir, `${parsedPath.name}-v${newRevision}${parsedPath.ext}`);
  const absoluteNewWorkingPath = boundedOutput(root, newWorkingPath);
  /*
   * The guard that refuses to destroy a file Plangonaut did not write, and the
   * one case that is not destruction.
   *
   * The refusal is right and it stays: a working file the ledger does not know
   * about may be anybody's, and overwriting it is irreversible in a way nothing
   * here can undo. It is also the guard that caught the pilot's hand-written
   * architecture document, which is the good news in that finding.
   *
   * But it made the repair impossible. An agent that wrote `docs/design-v1.md`
   * by hand and then tries to record it — passing that same file as
   * `--content-file`, which is the only sensible thing to pass — is refused for
   * overwriting a file with its own bytes. So `validate` could name the problem
   * and the suggested remedy could not run, which is a worse place to be than
   * not warning at all.
   *
   * Byte equality is what separates the two. If the file already on disk hashes
   * to exactly what this save would write, nothing is lost by claiming it: the
   * bytes stay, and the only thing that changes is that they now have a digest,
   * a revision and an owner. Any other content is still refused, unchanged.
   *
   * The distinction is stated in the output rather than left silent, because
   * "adopted the file that was already there" and "wrote a new revision" are
   * different events for whoever reads the folder afterwards.
   */
  const adoptingExistingFile =
    fs.existsSync(absoluteNewWorkingPath) &&
    absoluteNewWorkingPath !== resolveRecorded(root, artifact.working_path || "") &&
    sha256(fs.readFileSync(absoluteNewWorkingPath)) === hash;
  if (
    fs.existsSync(absoluteNewWorkingPath) &&
    absoluteNewWorkingPath !== resolveRecorded(root, artifact.working_path || "") &&
    !adoptingExistingFile
  ) {
    throw new PlangonautError(
      `Refusing to overwrite untracked working file ${newWorkingPath}\n` +
      `It is already there with different content, and this save would replace it.\n` +
      `To record the file as it stands, pass it as --content-file so the bytes match; to replace it, move it aside first.\n` +
      `Nothing was written.`
    );
  }

  artifact.working_path = newWorkingPath;
  artifact.revision = newRevision;
  artifact.content_hash = hash;
  artifact.provenance = sources;
  /*
   * A save records who wrote the revision. It does not start an editing session.
   *
   * This line used to be `artifact.lock_owner = owner`, and it is the origin of
   * the whole defect: every save silently took a lock that nothing ever
   * released, so the author of the last revision and the holder of an editing
   * session became the same field. They are different facts with different
   * lifetimes - the author belongs to the event that produced the revision, and
   * is recorded there, permanently.
   *
   * A caller that genuinely holds an editing session keeps it: `--session` says
   * so, and the lock is refreshed rather than invented. A caller that does not
   * pass one leaves the document unlocked, which is what a finished write is.
   */
  const savingSession = typeof flags.session === "string" ? String(flags.session).trim() : "";
  if (savingSession) {
    artifact.lock = {
      owner,
      session: savingSession,
      host: os.hostname(),
      pid: sessionPid(flags),
      acquired_at: artifact.lock?.session === savingSession ? artifact.lock.acquired_at : now(),
      renewed_at: now(),
    };
    artifact.lock_owner = owner;
  }
  // A new working revision supersedes the publication: the base file keeps the
  // finalized bytes, but the artifact is no longer what doc-finalize published.
  artifact.status = "DRAFT";
  
  const timestamp = now();
  state.updated_at = timestamp;
  const stateRevision = state.revision + 1;
  const eventId = crypto.randomUUID();
  state.revision = stateRevision;
  state.last_event_id = eventId;
  const deletionIntentIds = matchingDeletionIntents(root, id, hash, sourceRevision, sourceHash);
  const event = { event_id: eventId, type: "DOCUMENT_SAVED", state_revision: stateRevision, at: timestamp, idempotency_key: key, artifact_id: id, revision: newRevision, hash, owner, sources, diff, deletion_intent_ids: deletionIntentIds };
  assertPendingState(root, state, event);
  const transaction = beginFileTransaction(root, event, [absoluteNewWorkingPath, ...(priorArtifact?.working_path ? [resolveRecorded(root, priorArtifact.working_path), historyLocation(root, priorArtifact, priorArtifact.revision)] : [])]);
  try {
    if (priorArtifact) archiveCurrentRevision(root, priorArtifact);
    atomicWrite(absoluteNewWorkingPath, content, root);
    commitState(root, location, state, event);
    completeFileTransaction(transaction);
  } catch (error) {
    if (fs.existsSync(transaction)) rollbackFileTransaction(root, transaction);
    throw error;
  }
  // `doc-mark-deletion` records a human-approved removal, and the next save links
  // the matching marker. Nothing ever *required* one: a save that removed 44
  // recorded lines went through with `deletion_intent_ids: []` and said nothing,
  // which makes the intentional-deletion guarantee ceremonial (ALN-005 pilot B).
  //
  // Refusing the save would be a `DOCOP-001` behaviour change and, under D3, needs
  // a corpus scenario before either implementation moves. Saying so does not: the
  // removal is reported, with the count, and the operation still applies.
  const removedLines = diff.filter((line: any) => line.kind === "removed").length;
  const warnings = removedLines && !deletionIntentIds.length
    ? [`This revision removes ${removedLines} recorded line${removedLines === 1 ? "" : "s"} and no deletion intent was linked. Content is preserved in .beave/history/. Use doc-mark-deletion first when a removal is deliberate, so the reason is recorded with it.`]
    : [];
  console.log(`${JSON.stringify({ artifact_id: id, working_path: newWorkingPath, revision: newRevision, hash, adopted_existing_file: adoptingExistingFile, diff, deletion_intent_ids: deletionIntentIds, warnings }, null, 2)}`);
}

// ---------------------------------------------------------------------------
// The document lock, and the four things it can be
// ---------------------------------------------------------------------------

/*
 * This is not `plangonaut unlock`.
 *
 * `unlock` releases the **project** lock in `.plangonaut/lock.json`: one file,
 * one process, held for the duration of a single command, and about whether two
 * writers are touching the folder at once.
 *
 * This is about one document and one editing session, it lives inside the state
 * as a field of the artifact, and it survives across commands on purpose. They
 * are different mechanisms with different lifetimes, and the names are kept
 * apart so that nobody reaches for the wrong one in a hurry.
 */

type DocumentLockState =
  /** Nothing holds it. */
  | "FREE"
  /** Held by the caller's own session, on this host. */
  | "MINE"
  /** Held by somebody else, or by a session that is not this one. */
  | "HELD"
  /** This host, this owner, and the process is gone. Demonstrably over. */
  | "STALE"
  /** A bare name with no session, host or process. Nothing can be proved. */
  | "LEGACY_UNKNOWN";

interface DocumentLockReading {
  artifact: string;
  state: DocumentLockState;
  owner: string | null;
  session: string | null;
  host: string | null;
  pid: number | null;
  acquired_at: string | null;
  renewed_at: string | null;
  /** Why it was classified this way, in the words the user is shown. */
  because: string;
}

/**
 * What the lock on this artifact is, judged rather than assumed.
 *
 * The one classification everything else reads. `LEGACY_UNKNOWN` is deliberately
 * not folded into either `HELD` or `STALE`: a bare `"studio:Ale92"` carries no
 * host, no process and no time, so calling it live would strand the document
 * and calling it dead would let a second writer in behind somebody's back. It
 * is unknown, it is reported as unknown, and clearing it is a decision a person
 * takes with a reason attached.
 */
function readDocumentLock(artifact: Artifact, caller?: { owner?: string; session?: string }): DocumentLockReading {
  const base = {
    artifact: artifact.id,
    owner: null as string | null,
    session: null as string | null,
    host: null as string | null,
    pid: null as number | null,
    acquired_at: null as string | null,
    renewed_at: null as string | null,
  };

  const lock = artifact.lock ?? null;
  if (!lock) {
    if (!nonEmpty(artifact.lock_owner)) {
      return { ...base, state: "FREE", because: "nothing holds this document." };
    }
    return {
      ...base,
      state: "LEGACY_UNKNOWN",
      owner: artifact.lock_owner,
      because:
        `${artifact.lock_owner} is recorded as holding it, and the record carries no session, host, process or time. ` +
        `It was written by a version that set the holder's name and never cleared it, so whether anybody is still editing cannot be established from the project. ` +
        `It is neither assumed live nor assumed dead.`,
    };
  }

  const reading = {
    ...base,
    owner: lock.owner,
    session: lock.session,
    host: lock.host,
    pid: lock.pid ?? null,
    acquired_at: lock.acquired_at,
    renewed_at: lock.renewed_at ?? null,
  };

  if (caller?.session && lock.session === caller.session && lock.host === os.hostname()) {
    return { ...reading, state: "MINE", because: `held by this session (${lock.session}).` };
  }

  if (lock.host !== os.hostname()) {
    return {
      ...reading,
      state: "HELD",
      because: `held by ${lock.owner} on ${lock.host}, which is not this machine. Nothing here can tell whether that session is still running.`,
    };
  }
  /*
   * `false` is a dead process. `null` is a pid this engine cannot read, and it
   * is not the same answer: the existing `processIsAlive` draws that line
   * because a record whose pid was a string once had its lock taken from a
   * process that was running. An unreadable pid is held, not stale.
   */
  if (processIsAlive(lock.pid) === false) {
    return {
      ...reading,
      state: "STALE",
      because: `held by ${lock.owner} on this machine in process ${lock.pid}, which is no longer running. The session that took it has ended.`,
    };
  }
  return {
    ...reading,
    state: "HELD",
    because:
      lock.pid === null
        ? `held by ${lock.owner} on this machine in a session that recorded no process, so it cannot be shown to have ended.`
        : `held by ${lock.owner} on this machine in process ${lock.pid}, which is still running.`,
  };
}

/** The one sentence the refusals print, so six call sites cannot disagree. */
function documentLockRefusal(reading: DocumentLockReading, owner: string): string {
  const head = `Artifact ${reading.artifact} is locked by ${reading.owner}`;
  const remedy =
    reading.state === "STALE"
      ? `That session has ended. Recover it: plangonaut doc-lock-recover --project-root . --id ${reading.artifact} --owner ${owner} --operation-id <id>`
      : reading.state === "LEGACY_UNKNOWN"
        ? `This is a lock from an older version and its state cannot be established. Look at it first:\n` +
          `  plangonaut doc-lock --project-root . --id ${reading.artifact}\n` +
          `then, if you are satisfied nobody is editing it:\n` +
          `  plangonaut doc-lock-force-release --project-root . --id ${reading.artifact} --owner ${owner} --reason "<why>" --operation-id <id>`
        : `If they have finished, ${reading.owner} releases it with plangonaut doc-lock-release --project-root . --id ${reading.artifact} --owner ${reading.owner} --operation-id <id>.`;
  return `${head}.\n${reading.because}\n\n${remedy}\n\nThis is the document's own lock, not the project lock: plangonaut unlock is a different thing and will not help. Nothing was written.`;
}

/** Find the artifact, or say so in the words of the thing that was asked for. */
function artifactOrThrow(state: State, id: string): Artifact {
  const artifact = (state.artifacts ?? []).find((item) => item.id === id);
  if (!artifact) throw new PlangonautError(`No artifact ${id} in this project.`);
  return artifact;
}

/**
 * The process id of the editing session, when the caller named one.
 *
 * Never this process: see the note where it is used. A value that is not a
 * positive integer is `null`, because a pid nothing can check is the same as
 * no pid at all and pretending otherwise would let a typo strand a document.
 */
function sessionPid(flags: Flags): number | null {
  const raw = flags.pid;
  if (typeof raw !== "string") return null;
  const numeric = Number(raw);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

/**
 * The same result, said twice: once for a person and once for a program.
 *
 * A delegating writer must not read prose. `Finalized document ART-1 to
 * docs/spec.md` is a sentence written for somebody who already knows what they
 * asked for, and a caller that parses it is a caller that breaks the first time
 * the wording improves — which is a reason never to improve it.
 *
 * So every governed command that a writer drives can be asked for JSON, the
 * prose stays exactly as it was for everybody else, and nothing has to choose
 * between being readable and being usable.
 */
function say(flags: Flags, human: string, machine: Record<string, unknown>): void {
  if (flags.json === true) {
    console.log(JSON.stringify(machine, null, 2));
    return;
  }
  console.log(human);
}

function docLockStatus(flags: Flags): void {
  const root = resolveProject(required(flags, "project-root"));
  const state = validateRoot(root);
  const id = typeof flags.id === "string" ? String(flags.id).toUpperCase() : null;
  const session = typeof flags.session === "string" ? String(flags.session) : undefined;

  const artifacts = id ? [artifactOrThrow(state, id)] : (state.artifacts ?? []);
  const readings = artifacts.map((artifact) => readDocumentLock(artifact, { session }));

  if (flags.json === true) {
    console.log(JSON.stringify({ locks: readings }, null, 2));
    return;
  }
  if (!readings.length) return console.log("This project records no documents.");
  for (const reading of readings) {
    if (reading.state === "FREE" && id === null) continue;
    console.log(`${reading.artifact}: ${reading.state}`);
    console.log(`  ${reading.because}`);
    if (reading.acquired_at) console.log(`  acquired ${reading.acquired_at}${reading.renewed_at ? `, renewed ${reading.renewed_at}` : ""}`);
  }
  if (id === null && readings.every((reading) => reading.state === "FREE")) {
    console.log("No document in this project is locked.");
  }
  console.log(`\nThis is the document lock. The project lock is a different mechanism: plangonaut unlock --project-root .`);
}

/**
 * One mutation shape for every lock change, so the four commands cannot drift.
 *
 * Each of them changes the same field, records the same kind of event and takes
 * the same precautions; the only differences are who is allowed to do it and
 * what is written down about why.
 */
function commitLockChange(
  root: string,
  flags: Flags,
  input: {
    id: string;
    owner: string;
    type: string;
    /** The lock after the change. `null` releases it. */
    next: DocumentLock | null;
    previous: DocumentLockReading;
    reason?: string;
    idempotentMessage: string;
    /** Already in the target state: say so and write nothing. */
    settled?: (reading: DocumentLockReading) => boolean;
  },
): void {
  const key = idempotencyKey(flags);
  if (checkIdempotency(root, key)) return console.log(input.idempotentMessage);
  const { location, state } = loadState(root);
  assertNotBlocked(state);
  assertKnownOwner(state, input.owner);
  const artifact = artifactOrThrow(state, input.id);

  /*
   * Re-read under the lock.
   *
   * The classification the caller was shown came from a state read before the
   * project lock was taken. Between the two, another command may have released
   * or taken this document's lock, and acting on the earlier reading would be
   * the check passing and the world having moved.
   */
  const current = readDocumentLock(artifact, { owner: input.owner, session: input.next?.session });
  if (input.settled?.(current)) return console.log(input.idempotentMessage);

  const timestamp = now();
  if (input.next) {
    artifact.lock = { ...input.next, acquired_at: input.next.acquired_at || timestamp };
    artifact.lock_owner = input.next.owner;
  } else {
    artifact.lock = null;
    // Cleared together, on purpose: leaving the legacy field set while the
    // structured lock is gone would recreate the ambiguity this closes.
    artifact.lock_owner = "";
  }

  state.updated_at = timestamp;
  const stateRevision = state.revision + 1;
  const eventId = crypto.randomUUID();
  state.revision = stateRevision;
  state.last_event_id = eventId;
  const event = {
    event_id: eventId,
    type: input.type,
    state_revision: stateRevision,
    at: timestamp,
    idempotency_key: key,
    artifact_id: input.id,
    owner: input.owner,
    /*
     * What was there before, recorded in the event.
     *
     * A release that does not say what it released cannot be audited: the
     * field is gone from the state afterwards, and the event is the only place
     * a reader can learn that `studio:Ale92` ever held it.
     */
    previous_state: input.previous.state,
    previous_owner: input.previous.owner,
    previous_session: input.previous.session,
    previous_host: input.previous.host,
    previous_pid: input.previous.pid,
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.next ? { session: input.next.session, host: input.next.host, pid: input.next.pid } : {}),
  };
  commitState(root, location, state, event);
}

function docLockAcquire(flags: Flags): void {
  const root = resolveProject(required(flags, "project-root"));
  const { state } = loadState(root);
  const id = required(flags, "id").toUpperCase();
  const owner = required(flags, "owner").trim();
  const session = required(flags, "session").trim();
  if (!session) throw new PlangonautError(`--session cannot be empty: a lock with no session is the shape this replaces.`);
  const artifact = artifactOrThrow(state, id);
  const reading = readDocumentLock(artifact, { owner, session });

  if (reading.state === "MINE") {
    return console.log(`${id} is already held by this session (${session}).`);
  }
  if (reading.state !== "FREE") {
    throw new PlangonautError(documentLockRefusal(reading, owner), "PROJECT_STATE_UNTRUSTED");
  }

  commitLockChange(root, flags, {
    id,
    owner,
    type: "DOCUMENT_LOCK_ACQUIRED",
    previous: reading,
    /*
     * The session's process, not this command's.
     *
     * `process.pid` here is the CLI invocation, which exits the moment the
     * command returns — so every lock it took was already stale by the time
     * anything read it, and the classifier said so correctly about a lock
     * nobody had abandoned. The pid that matters belongs to whoever holds the
     * editing session, and only they can supply it.
     *
     * Absent is `null`, which the classifier reads as held-and-unprovable
     * rather than as dead. That is the right default: a lock that cannot be
     * shown to be over is not over.
     */
    next: { owner, session, host: os.hostname(), pid: sessionPid(flags), acquired_at: now() },
    idempotentMessage: `Idempotent retry: ${id} is already held by this session.`,
    settled: (current) => current.state === "MINE",
  });
  say(
    flags,
    `${id} is now held by ${owner}, session ${session}, on ${os.hostname()}.\n` +
      `Release it when the editing session ends: plangonaut doc-lock-release --project-root . --id ${id} --owner ${owner} --operation-id <id>`,
    { result: "acquired", artifact: id, owner, session, host: os.hostname(), pid: sessionPid(flags) },
  );
}

function docLockRelease(flags: Flags): void {
  const root = resolveProject(required(flags, "project-root"));
  const { state } = loadState(root);
  const id = required(flags, "id").toUpperCase();
  const owner = required(flags, "owner").trim();
  const artifact = artifactOrThrow(state, id);
  const reading = readDocumentLock(artifact, { owner });

  if (reading.state === "FREE") return console.log(`${id} is not locked.`);

  /*
   * The holder releases their own lock, and nobody else's.
   *
   * A different owner taking it silently is the failure mode the brief names,
   * and it is the one that costs the most: the second writer believes they hold
   * a document the first still has open. Every other road out of a lock -
   * recover and force-release - says what it is doing and why in an event.
   */
  if (reading.owner !== owner) {
    throw new PlangonautError(
      `${id} is held by ${reading.owner}, not by ${owner}.\n${reading.because}\n\n` +
      `A lock is released by the owner that holds it. If that owner is gone:\n` +
      (reading.state === "STALE"
        ? `  plangonaut doc-lock-recover --project-root . --id ${id} --owner ${owner} --operation-id <id>\n`
        : `  plangonaut doc-lock-force-release --project-root . --id ${id} --owner ${owner} --reason "<why>" --operation-id <id>\n`) +
      `Nothing was written.`,
      "PROJECT_STATE_UNTRUSTED",
    );
  }

  commitLockChange(root, flags, {
    id, owner, type: "DOCUMENT_LOCK_RELEASED", previous: reading, next: null,
    idempotentMessage: `Idempotent retry: ${id} is already released.`,
    settled: (current) => current.state === "FREE",
  });
  say(flags, `${id} is released. ${owner} no longer holds it.`, { result: "released", artifact: id, owner, previous_owner: reading.owner, previous_session: reading.session });
}

function docLockRecover(flags: Flags): void {
  const root = resolveProject(required(flags, "project-root"));
  const { state } = loadState(root);
  const id = required(flags, "id").toUpperCase();
  const owner = required(flags, "owner").trim();
  const artifact = artifactOrThrow(state, id);
  const reading = readDocumentLock(artifact, { owner });

  if (reading.state === "FREE") return console.log(`${id} is not locked; there is nothing to recover.`);

  /*
   * Recovery is for a lock that can be *shown* to be over.
   *
   * This host, and a process that is no longer running. Anything else - another
   * machine, a live process, or a legacy record with no evidence at all - is
   * not demonstrable, and the command says so rather than deciding on the
   * user's behalf. `force-release` exists for those, and asks for a reason.
   */
  if (reading.state !== "STALE") {
    throw new PlangonautError(
      `${id} cannot be recovered: its lock is not demonstrably over.\n${reading.because}\n\n` +
      (reading.state === "LEGACY_UNKNOWN"
        ? `A legacy lock records no host, process or session, so nothing can prove it ended. Releasing it is a decision, not a recovery:\n` +
          `  plangonaut doc-lock-force-release --project-root . --id ${id} --owner ${owner} --reason "<why>" --operation-id <id>\n`
        : `If you know that session has ended, release it deliberately:\n` +
          `  plangonaut doc-lock-force-release --project-root . --id ${id} --owner ${owner} --reason "<why>" --operation-id <id>\n`) +
      `Nothing was written.`,
      "PROJECT_STATE_UNTRUSTED",
    );
  }

  commitLockChange(root, flags, {
    id, owner, type: "DOCUMENT_LOCK_RECOVERED", previous: reading, next: null,
    reason: `process ${reading.pid} on ${reading.host} is no longer running`,
    idempotentMessage: `Idempotent retry: ${id} was already recovered.`,
    settled: (current) => current.state === "FREE",
  });
  say(
    flags,
    `${id} is recovered. ${reading.owner} held it in process ${reading.pid} on ${reading.host}, which has ended.\n` +
      `The document is now free. ${owner} may take it with plangonaut doc-lock-acquire, or finalize it directly.`,
    { result: "recovered", artifact: id, owner, previous_owner: reading.owner, previous_session: reading.session, previous_host: reading.host, previous_pid: reading.pid },
  );
}

function docLockForceRelease(flags: Flags): void {
  const root = resolveProject(required(flags, "project-root"));
  const { state } = loadState(root);
  const id = required(flags, "id").toUpperCase();
  const owner = required(flags, "owner").trim();
  const reason = required(flags, "reason").trim();
  if (!reason) throw new PlangonautError(`--reason cannot be empty: a lock taken from somebody else is a decision, and a decision without a reason is not auditable.`);
  const artifact = artifactOrThrow(state, id);
  const reading = readDocumentLock(artifact, { owner });

  if (reading.state === "FREE") return console.log(`${id} is not locked.`);

  /*
   * The dossier is for a person, so it is silent in JSON mode.
   *
   * A writer asking for `--json` and receiving eight lines of prose followed by
   * an object has been handed something it cannot parse, and the fix would be
   * for the caller to skip lines until one starts with a brace — which is
   * parsing prose by another name.
   */
  if (flags.json !== true) {
  console.log(`Releasing a lock this engine cannot prove is over.`);
  console.log(`  document   ${id}`);
  console.log(`  held by    ${reading.owner ?? "unknown"}`);
  console.log(`  session    ${reading.session ?? "not recorded"}`);
  console.log(`  host       ${reading.host ?? "not recorded"}`);
  console.log(`  process    ${reading.pid ?? "not recorded"}`);
  console.log(`  acquired   ${reading.acquired_at ?? "not recorded"}`);
  console.log(`  state      ${reading.state}`);
  console.log(`  reason     ${reason}`);
  console.log(``);
  }

  commitLockChange(root, flags, {
    id, owner, type: "DOCUMENT_LOCK_FORCE_RELEASED", previous: reading, next: null, reason,
    idempotentMessage: `Idempotent retry: ${id} was already force-released.`,
    settled: (current) => current.state === "FREE",
  });
  say(
    flags,
    `${id} is released by ${owner}. The previous holder is recorded in the event, not lost.`,
    {
      result: "force-released",
      artifact: id,
      owner,
      reason,
      previous_state: reading.state,
      previous_owner: reading.owner,
      previous_session: reading.session,
      previous_host: reading.host,
      previous_pid: reading.pid,
    },
  );
  if (reading.state === "LEGACY_UNKNOWN") {
    console.log(`If ${reading.owner} was in fact still editing, their unsaved work is in their editor and not in this project. Nothing here was overwritten.`);
  }
}


function docHistory(flags: Flags): void {
  const root = resolveProject(required(flags, "project-root"));
  const id = required(flags, "id").toUpperCase();
  const eventsFile = path.join(stateRoot(root), "events.jsonl");
  if (!fs.existsSync(eventsFile)) return;
  const lines = fs.readFileSync(eventsFile, "utf8").split(/\r?\n/).filter(Boolean);
  const history = [];
  for (const line of lines) {
    const event = JSON.parse(line);
    if (event.artifact_id === id) {
      history.push(event);
    }
  }
  console.log(JSON.stringify(history, null, 2));
}

function docRestore(flags: Flags): void {
  const root = resolveProject(required(flags, "project-root"));
  const key = idempotencyKey(flags);
  if (checkIdempotency(root, key)) return console.log(`Idempotent retry: doc-restore already applied.`);
  const state = validateRoot(root, true);
  const location = path.join(stateRoot(root), "state.json");
  assertNotBlocked(state);
  
  const id = required(flags, "id").toUpperCase();
  const restoreRevision = Number(required(flags, "revision"));
  const owner = required(flags, "owner");
  
  const artifact = state.artifacts.find(a => a.id === id);
  if (!artifact) throw new PlangonautError(`Artifact ${id} not found.`);
  const stale = expectedArtifactErrors(flags, artifact);
  if (stale.length) throw new PlangonautError(`Document restore refused:\n- ${stale.join("\n- ")}\nNo changes written.`);
  
  {
    const reading = readDocumentLock(artifact, { owner });
    if (reading.state !== "FREE" && reading.owner !== owner) {
      throw new PlangonautError(documentLockRefusal(reading, owner), "PROJECT_STATE_UNTRUSTED");
    }
  }
  
  assertNoExternalEdit(root, artifact);

  const parsedPath = path.parse(artifact.base_path);
  const historyFile = historyLocation(root, artifact, restoreRevision);
  
  if (!fs.existsSync(historyFile)) {
    throw new PlangonautError(`History file for revision ${restoreRevision} not found.`);
  }
  
  const content = fs.readFileSync(historyFile, "utf8");
  const hash = sha256(content);
  
  const newRevision = artifact.revision + 1;
  const newWorkingPath = path.posix.join(parsedPath.dir, `${parsedPath.name}-v${newRevision}${parsedPath.ext}`);
  const absoluteNewWorkingPath = boundedOutput(root, newWorkingPath);
  if (fs.existsSync(absoluteNewWorkingPath)) throw new PlangonautError(`Refusing to overwrite untracked working file ${newWorkingPath}`);
  const priorArtifact = { ...artifact, provenance: [...(artifact.provenance ?? [])] };

  artifact.working_path = newWorkingPath;
  artifact.revision = newRevision;
  artifact.content_hash = hash;
  // Restoring writes a revision and does not open an editing session, for the
  // same reason a save does not. The author is on the event.
  artifact.status = "DRAFT";
  
  const timestamp = now();
  state.updated_at = timestamp;
  const stateRevision = state.revision + 1;
  const eventId = crypto.randomUUID();
  state.revision = stateRevision;
  state.last_event_id = eventId;
  const event = { event_id: eventId, type: "DOCUMENT_RESTORED", state_revision: stateRevision, at: timestamp, idempotency_key: key, artifact_id: id, restored_revision: restoreRevision, new_revision: newRevision, hash, owner };
  assertPendingState(root, state, event);
  const transaction = beginFileTransaction(root, event, [absoluteNewWorkingPath, resolveRecorded(root, priorArtifact.working_path), historyLocation(root, priorArtifact, priorArtifact.revision)]);
  try {
    archiveCurrentRevision(root, priorArtifact);
    atomicWrite(absoluteNewWorkingPath, content, root);
    commitState(root, location, state, event);
    completeFileTransaction(transaction);
  } catch (error) {
    if (fs.existsSync(transaction)) rollbackFileTransaction(root, transaction);
    throw error;
  }
  say(
    flags,
    `Restored document ${id} to ${newWorkingPath} (from revision ${restoreRevision} as new revision ${newRevision})`,
    {
      result: "restored",
      artifact_id: id,
      working_path: newWorkingPath,
      revision: newRevision,
      restored_from_revision: restoreRevision,
      content_hash: artifact.content_hash,
      status: artifact.status,
    },
  );
}

function docFinalize(flags: Flags): void {
  const root = resolveProject(required(flags, "project-root"));
  const key = idempotencyKey(flags);
  if (checkIdempotency(root, key)) return console.log(`Idempotent retry: doc-finalize already applied.`);
  const state = validateRoot(root, true);
  const location = path.join(stateRoot(root), "state.json");
  assertNotBlocked(state);
  
  const id = required(flags, "id").toUpperCase();
  const owner = required(flags, "owner");
  
  const artifact = state.artifacts.find(a => a.id === id);
  if (!artifact) throw new PlangonautError(`Artifact ${id} not found.`);
  const stale = expectedArtifactErrors(flags, artifact);
  if (stale.length) throw new PlangonautError(`Document finalize refused:\n- ${stale.join("\n- ")}\nNo changes written.`);
  
  {
    const reading = readDocumentLock(artifact, { owner });
    if (reading.state !== "FREE" && reading.owner !== owner) {
      throw new PlangonautError(documentLockRefusal(reading, owner), "PROJECT_STATE_UNTRUSTED");
    }
  }
  if (!artifact.working_path) {
    throw new PlangonautError(`Artifact ${id} has no working path to finalize.`);
  }
  // Already published: working_path === base_path, so the previous code copied
  // the file onto itself and then moved it into history, deleting the publication.
  if (artifact.working_path === artifact.base_path) {
    throw new PlangonautError(`Artifact ${id} is already finalized at ${artifact.base_path}. Save a new revision before finalizing again.`);
  }

  assertNoExternalEdit(root, artifact);

  const absoluteWorking = resolveRecorded(root, artifact.working_path);
  const absoluteBase = boundedOutput(root, artifact.base_path);

  if (!fs.existsSync(absoluteWorking)) {
    throw new PlangonautError(`Working file ${absoluteWorking} does not exist.`);
  }

  // DOCOP-001, "Finalization": the audit "reports suspected accidental loss before
  // writing". The base file can hold content Plangonaut never produced: a document that
  // predates the project, or a hand edit made while the artifact was in DRAFT,
  // which assertNoExternalEdit cannot see because it guards the working file.
  // Overwriting it is irreversible, so it is refused unless the human approves.
  let supersededPath: string | undefined;
  let supersededHash: string | undefined;
  let supersededSnapshot: string | undefined;
  const priorBase = fs.existsSync(absoluteBase) ? fs.readFileSync(absoluteBase) : null;
  if (fs.existsSync(absoluteBase)) {
    const baseHash = sha256(fs.readFileSync(absoluteBase, "utf8"));
    if (!recordedDigests(root, id).has(baseHash)) {
      if (!flags["accept-base-overwrite"]) {
        throw new PlangonautError(`${artifact.base_path} already holds content Plangonaut never recorded (sha256 ${baseHash}). Finalizing would overwrite it and no document backup exists. Import it with doc-save, move it aside, or re-run with --accept-base-overwrite to archive it under ${locateState(root).name}/history/ first.`);
      }
      const stamp = new Date().toISOString().replaceAll(":", "").replaceAll(".", "");
      const snapshot = path.join(stateRoot(root), "history", `${id}-external-${stamp}${path.parse(artifact.base_path).ext}`);
      supersededSnapshot = snapshot;
      supersededPath = path.relative(root, snapshot).replaceAll("\\", "/");
      supersededHash = baseHash;
    }
  }
  const priorArtifact = { ...artifact, provenance: [...(artifact.provenance ?? [])] };
  const workingBytes = fs.readFileSync(absoluteWorking);
  artifact.working_path = artifact.base_path;
  artifact.status = "PUBLISHED";
  /*
   * Publishing ends the editing session it was holding.
   *
   * This is the fourth of the release points and the only one the engine can
   * reach on its own: the others - closing a tab, changing project, closing the
   * application - belong to whoever is editing. A finalized document is not
   * being edited by definition, so leaving the lock on it is the same defect in
   * a smaller form.
   *
   * Recorded on the DOCUMENT_FINALIZED event rather than as a separate lock
   * event, because it is one act: nothing observable happens between the two.
   */
  const releasedLock = readDocumentLock(artifact, { owner });
  artifact.lock = null;
  artifact.lock_owner = "";
  
  const timestamp = now();
  state.updated_at = timestamp;
  const stateRevision = state.revision + 1;
  const eventId = crypto.randomUUID();
  state.revision = stateRevision;
  state.last_event_id = eventId;
  const event = { event_id: eventId, type: "DOCUMENT_FINALIZED", state_revision: stateRevision, at: timestamp, idempotency_key: key, artifact_id: id, revision: artifact.revision, hash: artifact.content_hash, owner, ...(releasedLock.state !== "FREE" ? { released_lock_owner: releasedLock.owner, released_lock_state: releasedLock.state } : {}), ...(supersededPath ? { superseded_external_path: supersededPath, superseded_external_hash: supersededHash } : {}) };
  assertPendingState(root, state, event);
  const transaction = beginFileTransaction(root, event, [absoluteBase, absoluteWorking, historyLocation(root, priorArtifact, priorArtifact.revision), ...(supersededSnapshot ? [supersededSnapshot] : [])]);
  try {
    if (supersededSnapshot && priorBase) {
      fs.mkdirSync(path.dirname(supersededSnapshot), { recursive: true });
      fs.copyFileSync(absoluteBase, supersededSnapshot);
    }
    atomicWrite(absoluteBase, workingBytes, root);
    archiveCurrentRevision(root, priorArtifact);
    commitState(root, location, state, event);
    completeFileTransaction(transaction);
  } catch (error) {
    if (fs.existsSync(transaction)) rollbackFileTransaction(root, transaction);
    throw error;
  }
  if (supersededPath) console.log(`Archived the unrecorded content of ${artifact.base_path} to ${supersededPath}`);
  say(flags, `Finalized document ${id} to ${artifact.base_path}`, {
    result: "finalized",
    artifact_id: id,
    base_path: artifact.base_path,
    working_path: artifact.working_path,
    revision: artifact.revision,
    content_hash: artifact.content_hash,
    status: artifact.status,
    released_lock_owner: releasedLock.state === "FREE" ? null : releasedLock.owner,
  });
}

function portableMarkdown(): string {
  const paths = [path.join(SKILL_ROOT, "SKILL.md"), ...fs.readdirSync(path.join(SKILL_ROOT, "references")).filter((name: string) => name.endsWith(".md")).sort().map((name: string) => path.join(SKILL_ROOT, "references", name))];
  const sections = ["<!-- Generated by Plangonaut. Edit canonical sources, not this file. -->", `<!-- Plangonaut version: ${VERSION} -->`, "# Plangonaut — Portable Semantic Edition", "", "Use this document when the AI runtime cannot install or execute the Plangonaut skill. Follow the same human gates and preserve the final state block manually.", ""];
  for (const source of paths) {
    let text = fs.readFileSync(source, "utf8");
    if (path.basename(source) === "SKILL.md" && text.startsWith("---")) text = text.split("---", 3)[2].trimStart();
    sections.push(`\n---\n\n## Source: ${path.relative(SKILL_ROOT, source).replaceAll("\\", "/")}\n`, text.trimEnd(), "");
  }
  sections.splice(2, 0, `<!-- Canonical source digest: ${canonicalSourceDigest()} -->`);
  return `${sections.join("\n").trimEnd()}\n`;
}

function adapterRelative(target: string): string {
  if (["codex", "gemini", "agy"].includes(target)) return path.join(".agents", "skills", "plangonaut");
  if (target === "claude") return path.join(".claude", "skills", "plangonaut");
  throw new PlangonautError(`Unsupported target: ${target}`);
}

function copySkill(destination: string, target: string): void {
  if (fs.existsSync(destination)) throw new PlangonautError(`Destination already exists: ${destination}`);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(SKILL_ROOT, destination, { recursive: true });
  writeJson(path.join(destination, "plangonaut-adapter.json"), { generated_by: `plangonaut ${VERSION}`, target, generated_at: now(), canonical_source_sha256: canonicalSourceDigest() });
}

function installedSourceDigest(destination: string): string {
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.name !== "plangonaut-adapter.json") files.push(full);
    }
  };
  visit(destination);
  files.sort((left, right) => {
    const a = path.relative(destination, left).replaceAll("\\", "/");
    const b = path.relative(destination, right).replaceAll("\\", "/");
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const digest = crypto.createHash("sha256");
  for (const location of files) {
    digest.update(path.relative(destination, location).replaceAll("\\", "/"));
    digest.update("\0");
    digest.update(fs.readFileSync(location));
    digest.update("\0");
  }
  return digest.digest("hex");
}

function verifyInstall(flags: Flags): void {
  const target = required(flags, "target");
  const scope = typeof flags.scope === "string" ? flags.scope : "project";
  if (!new Set(["project", "workspace", "user"]).has(scope)) throw new PlangonautError("--scope must be project, workspace, or user");
  const base = scope === "user" ? os.homedir() : path.resolve((typeof flags["project-root"] === "string" ? flags["project-root"] : undefined) ?? process.cwd());
  const destination = path.join(base, adapterRelative(target));
  
  if (!fs.existsSync(destination)) {
    throw new PlangonautError(`Target ${target} is not installed at ${destination}`);
  }
  const manifestFile = path.join(destination, "plangonaut-adapter.json");
  if (!fs.existsSync(manifestFile)) {
    throw new PlangonautError(`Missing plangonaut-adapter.json in ${destination}`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  if (!manifest.canonical_source_sha256) {
    throw new PlangonautError(`plangonaut-adapter.json lacks canonical_source_sha256`);
  }
  
  const currentDigest = installedSourceDigest(destination);
  if (currentDigest !== manifest.canonical_source_sha256) {
    throw new PlangonautError(`Drift detected in installed skill at ${destination}. Hashes do not match.`);
  }
  console.log(`Installation for ${target} at ${destination} is pristine and matches original source.`);
}

function exportTarget(flags: Flags): void {
  const target = required(flags, "target");
  const outputRoot = path.resolve(required(flags, "output-dir"));
  fs.mkdirSync(outputRoot, { recursive: true });
  if (target === "portable") {
    const destination = path.join(outputRoot, "plangonaut-portable.md");
    if (fs.existsSync(destination)) throw new PlangonautError(`Destination already exists: ${destination}`);
    atomicWrite(destination, portableMarkdown());
    return console.log(`Exported portable to ${destination}`);
  }
  const destination = path.join(outputRoot, adapterRelative(target));
  copySkill(destination, target);
  console.log(`Exported ${target} to ${destination}`);
}

function install(flags: Flags): void {
  const target = required(flags, "target");
  const scope = typeof flags.scope === "string" ? flags.scope : "project";
  if (!new Set(["project", "workspace", "user"]).has(scope)) throw new PlangonautError("--scope must be project, workspace, or user");
  const base = scope === "user" ? os.homedir() : path.resolve((typeof flags["project-root"] === "string" ? flags["project-root"] : undefined) ?? process.cwd());
  const targets = target === "all" ? ["codex", "claude"] : [target];
  const destinations = targets.map((item) => ({ item, destination: path.join(base, adapterRelative(item)) }));
  for (const { destination } of destinations) if (fs.existsSync(destination)) throw new PlangonautError(`Refusing to overwrite existing skill: ${destination}`);
  for (const { item, destination } of destinations) {
    console.log(`${flags["dry-run"] ? "Would install" : "Installing"} ${item} skill at ${destination}`);
    if (!flags["dry-run"]) copySkill(destination, item);
  }
  if (target === "all") console.log("Codex and Gemini share .agents/skills/plangonaut; no duplicate Gemini copy was created.");
}

/**
 * The document flow, written once and shown everywhere it is needed.
 *
 * The pilot's agent did not skip `doc-diff`/`doc-save` out of carelessness. It
 * read the skill, which described the *result* — one visible working file per
 * document, `-vN` advanced — produced exactly that result by hand, and never
 * learned that two commands existed to produce it. Then, on finally reaching
 * `doc-save`, it met a mandatory `--confirm-token` that `help` did not list and
 * that lived only in `engine-contract.md`, tried `--confirm`, and was refused.
 *
 * Doing the right thing cost a reference lookup and two failures; writing the
 * file by hand cost nothing. When that is the ratio, the file gets written by
 * hand. So the flow is stated in the general help, in this command's own help,
 * in the refusal when the token is missing, and in the skill — the four places
 * an agent can be standing when it needs it.
 */
const DOCUMENT_FLOW = [
  `The document flow is two commands, and the second will not run without the first:`,
  ``,
  `  1. plangonaut doc-diff --project-root . --id ART-<NAME> --base-path docs/<name>.md \\`,
  `       --content-file <the file you wrote> --owner <owner>`,
  `     Writes nothing. Prints the diff that would be applied and a confirmation_token.`,
  ``,
  `  2. Read the diff. That is the review the token attests to.`,
  ``,
  `  3. plangonaut doc-save --project-root . --id ART-<NAME> --base-path docs/<name>.md \\`,
  `       --content-file <the same file> --owner <owner> \\`,
  `       --confirm-token <confirmation_token from step 1> --operation-id <id>`,
  ``,
  `About the token:`,
  `  Purpose      it attests that this exact change was previewed before it was written.`,
  `  Bound to     the artifact id, the base path, the owner, the artifact's current`,
  `               revision and digest, and the digest of the content being proposed.`,
  `  Expiry       none. It is a digest of those six things, not a timer.`,
  `  Reuse        as long as all six still hold. Change the content, the owner, the`,
  `               base path, or let the artifact advance a revision, and the old token`,
  `               stops matching — which is the point: it no longer describes this save.`,
  `  Refused      a doc-diff that reported blockers returns an empty token, so a`,
  `               preview the engine refused cannot confirm a save.`,
].join("\n");

/**
 * Per-command help.
 *
 * `plangonaut help` lists every command on one line each, which is the right
 * shape for finding a command and the wrong shape for using one: the line for
 * `doc-save` had eight options on it and was missing the mandatory one. These
 * entries are for the second moment. A command without an entry falls back to
 * the general help rather than printing an empty page.
 */
const COMMAND_HELP: Record<string, string> = {
  ...(() => {
    /*
     * One explanation, reachable from any of the five.
     *
     * The family was added with usage lines in the general help and nothing
     * else, and the general help cannot carry six paragraphs about one
     * mechanism without becoming unreadable. A reader who types
     * `doc-lock-force-release --help` is about to take a document away from a
     * colleague; that is the moment to explain what they are doing, not a
     * moment to print an argument list.
     */
    const text = [
      `plangonaut doc-lock — who is editing a governed document, and how that ends.`,
      ``,
      `  doc-lock               --project-root DIR [--id ART-<NAME>] [--json]`,
      `  doc-lock-acquire       --project-root DIR --id ART-<NAME> --owner NAME --session S`,
      `                         [--pid N] --operation-id ID`,
      `  doc-lock-release       --project-root DIR --id ART-<NAME> --owner NAME --operation-id ID`,
      `  doc-lock-recover       --project-root DIR --id ART-<NAME> --owner NAME --operation-id ID`,
      `  doc-lock-force-release --project-root DIR --id ART-<NAME> --owner NAME --reason TEXT`,
      `                         --operation-id ID`,
      ``,
      `THIS IS NOT \`plangonaut unlock\`.`,
      `  unlock releases the *project* lock in ${STATE_DIR}/lock.json: one file, one`,
      `  process, held for the length of a single command, about two writers touching`,
      `  the same folder at once. This is one document and one editing session, it`,
      `  lives inside the state as a field of the artifact, and it survives across`,
      `  commands on purpose. Reaching for unlock will not release a document.`,
      ``,
      `WHO MAY RELEASE IT`,
      `  The owner holding it, with doc-lock-release. Nobody else, and never`,
      `  silently: a second owner taking a lock behind somebody's back is how two`,
      `  people come to believe they each have a document open. The other two roads`,
      `  out both record an event saying what they did and why.`,
      ``,
      `HOW "OBSOLETE" IS ESTABLISHED`,
      `  Only one way: the lock names this machine and a process that is no longer`,
      `  running. That is what doc-lock-recover accepts and nothing else. A lock`,
      `  from another host is never judged from here, because this machine cannot`,
      `  see whether that session is alive. A legacy lock — a bare owner name with`,
      `  no session, host, process or time, written by a version that set the name`,
      `  and never cleared it — carries no evidence at all, so it is reported as`,
      `  LEGACY_UNKNOWN and is neither assumed live nor assumed dead.`,
      ``,
      `AFTER A CRASH`,
      `  Run doc-lock to see the state. A session that died on this machine reads`,
      `  STALE, and doc-lock-recover clears it. Anything else needs`,
      `  doc-lock-force-release and a reason, which is a decision rather than a`,
      `  recovery and is recorded as one.`,
      ``,
      `WHAT GETS RECORDED`,
      `  DOCUMENT_LOCK_ACQUIRED, _RELEASED, _RECOVERED and _FORCE_RELEASED. Each`,
      `  carries the previous holder, session, host and process, because once the`,
      `  field is cleared the event is the only place a reader can learn who held`,
      `  it. doc-finalize also releases the session it was holding, and records`,
      `  that on its own event.`,
      ``,
      `CLOSING AN OLD APPLICATION DOES NOT RELEASE ANYTHING`,
      `  A build that predates this protocol never releases a document lock: it has`,
      `  no code path that clears the field. Closing a tab, closing the window or`,
      `  restarting the machine will not help, and advice to try is advice that`,
      `  cannot work. Use these commands instead.`,
      ``,
      `Reading is free: doc-lock writes nothing and records no event.`,
    ].join("\n");
    return {
      "doc-lock": text,
      "doc-lock-acquire": text,
      "doc-lock-release": text,
      "doc-lock-recover": text,
      "doc-lock-force-release": text,
    };
  })(),
  "doc-diff": [
    `plangonaut doc-diff — preview a governed document change. Writes nothing.`,
    ``,
    `  --project-root DIR     the project`,
    `  --id ART-<NAME>        the artifact id; invent one for a new document`,
    `  --base-path PATH       the document's stable name, relative to the root,`,
    `                         without the -vN suffix (docs/architecture.md)`,
    `  --content-file FILE    the file holding the proposed content`,
    `  --owner NAME           one of the five recorded owners`,
    `  --sources DEC-1,REQ-2  optional: what this revision comes from`,
    `  --expected-revision N  optional: refuse if the artifact has moved on`,
    `  --expected-hash HASH   optional: refuse if the content has moved on`,
    ``,
    `It prints JSON: the diff, the next revision, and confirmation_token.`,
    `An empty confirmation_token means the preview found blockers; they are listed`,
    `in the same document, and doc-save would refuse for the same reasons.`,
    ``,
    DOCUMENT_FLOW,
  ].join("\n"),
  "doc-save": [
    `plangonaut doc-save — write a governed document revision.`,
    ``,
    `  --project-root DIR     the project`,
    `  --id ART-<NAME>        the artifact id`,
    `  --base-path PATH       the document's stable name, relative to the root`,
    `  --content-file FILE    the file holding the content to write`,
    `  --owner NAME           one of the five recorded owners`,
    `  --confirm-token TOKEN  REQUIRED. The confirmation_token doc-diff printed.`,
    `  --operation-id ID      REQUIRED. 3-128 characters, unique per operation.`,
    `  --sources DEC-1,REQ-2  optional: what this revision comes from`,
    `  --expected-revision N  optional: refuse if the artifact has moved on`,
    `  --expected-hash HASH   optional: refuse if the content has moved on`,
    ``,
    `The content is written to <base>-v<N+1>.md and the artifact records its digest.`,
    `A file already at that path with exactly the same bytes is adopted rather than`,
    `overwritten, which is how a document written by hand is brought into the ledger.`,
    `One with different bytes is refused: it may be somebody else's.`,
    ``,
    DOCUMENT_FLOW,
  ].join("\n"),
  validate: [
    `plangonaut validate — check that the project's state, history and documents agree.`,
    ``,
    `  --project-root DIR     the project`,
    `  --strict               turn warnings into failures (exit 2)`,
    ``,
    `Without --strict it reports two different things and treats them differently.`,
    `A state that disagrees with its own history, a recorded digest that no longer`,
    `matches its file, or a record pointing outside the project is a failure.`,
    `A Markdown document the project looks like it should be governing and does not`,
    `is a warning: it says nothing about whether the recorded state is sound, and a`,
    `project is entitled to hold files Plangonaut did not write. --strict is for the`,
    `caller who has decided it may not — a release check, a handoff, a pipeline.`,
  ].join("\n"),
  "qa-ask": [
    `plangonaut qa-ask — open a question in the interview ledger.`,
    ``,
    `  --project-root DIR     the project`,
    `  --id QNA-0001          the question id`,
    `  --question TEXT        or --question-file FILE`,
    `  --rationale TEXT       or --rationale-file FILE: why this question, now`,
    `  --owner NAME           one of the five recorded owners`,
    `  --operation-id ID      REQUIRED. 3-128 characters, unique per operation.`,
    `  --module N             optional: the questionnaire module it belongs to`,
    `  --planned              record it as intended but not yet asked`,
    `  --agent NAME           optional: which agent is asking`,
    ``,
    `An id that already exists is refused, and the refusal says what that entry is`,
    `currently doing. A PLANNED entry — one qa-settle --next-id wrote ahead of time —`,
    `is answered with qa-answer, not superseded: there is no answer to correct yet.`,
  ].join("\n"),
  override: [
    `plangonaut override — record that a person changed the project's direction.`,
    ``,
    `  --project-root DIR       the project`,
    `  --instruction-file FILE  the instruction, as a file INSIDE the project`,
    `  --owner NAME             one of the five recorded owners`,
    `  --operation-id ID        REQUIRED. 3-128 characters, unique per operation.`,
    `  --reason TEXT            optional: why the direction changed`,
    ``,
    `The ledger records the path, so the file has to be one the folder can carry: a`,
    `path inside the project root, not absolute, not climbing out with "..", not a`,
    `symlink resolving outside, and not inside .plangonaut. Write the instruction`,
    `into the project first. An override is a change of direction — it is among the`,
    `last things that may become unreadable.`,
    ``,
    `Recording one blocks further questionnaire work until plangonaut reconcile runs.`,
  ].join("\n"),
  next: [
    `plangonaut next — what to work on, and why that before the rest.`,
    ``,
    `  --project-root DIR     the project`,
    `  --count N              how many questions in this block (1-20)`,
    `  --remember             record that size as the project's own, from now on`,
    `  --owner NAME           with --remember: one of the five recorded owners`,
    `  --operation-id ID      with --remember: 3-128 characters, unique per operation`,
    ``,
    `A block is how many questions are laid out at once. It is not how many an`,
    `interview may have: an interview runs as many blocks as the gaps need, and`,
    `ends when every applicable module is confirmed, deferred or recorded as not`,
    `applicable — never because a count ran out.`,
    ``,
    `Without --count it uses the size the project recorded, or 5 if nobody has set`,
    `one. --count on its own is this block only and changes nothing; --remember is`,
    `how a preference is stated, so asking for three once never quietly becomes the`,
    `way the project works. Without --remember this command writes nothing.`,
    ``,
    `It reads the interview ledger before the questionnaire, so a question already`,
    `answered is not proposed again, and a question already planned is proposed as`,
    `itself rather than replaced by a catalogue one. It also reports where the`,
    `interview has been digging and which modules nothing has touched, and names`,
    `any recorded contradiction before it offers a next step.`,
  ].join("\n"),
  "handoff-check": [
    `plangonaut handoff-check — is this folder enough for somebody who was not here?`,
    ``,
    `  --project-root DIR     the project`,
    `  --json                 the report as data`,
    ``,
    `validate asks whether the record is sound. This asks the other question, and`,
    `a project can pass the first for months while failing the second. Blocking`,
    `findings are things that would stop a recipient; advisory ones are worth`,
    `knowing. It exits 2 when anything is blocking.`,
    ``,
    `What it looks at, when it reports a document nobody is governing:`,
    ``,
    `  only Markdown          an ordinary source file, a lockfile, an asset or a`,
    `                         build artifact is never reported, whatever it is`,
    `                         named and wherever it sits.`,
    `  not other people's     node_modules, vendor, third_party, dist, build, out,`,
    `                         target, coverage, caches, temporary directories and`,
    `                         anything beginning with a dot are not walked.`,
    `  where documents live   the project root, the governed directories, and`,
    `                         directories whose name says what they hold — docs,`,
    `                         specs, plans, decisions, adr, requirements and the`,
    `                         like. A working file inside application code is`,
    `                         somebody's note, not an ungoverned deliverable.`,
    `  not what was here      Markdown that existed when the project was`,
    `                         initialised is the repository's, not the plan's.`,
    `  not what you excluded  plangonaut govern --exclude records a deliberate`,
    `                         exception with its reason, and it is respected.`,
    ``,
    `Repository files — README, CHANGELOG, LICENSE, CONTRIBUTING and their usual`,
    `companions — are never reported, at any depth.`,
  ].join("\n"),
};

/**
 * What each command actually takes, in one table that several readers use.
 *
 * WHY THIS EXISTS
 * ---------------
 * An agent driving the pilot invented `plangonaut coverage`. It was told to run
 * `capabilities` before its first mutation, and `capabilities` answered with a
 * version, a schema number and three lists of modes — nothing about commands,
 * nothing about options, nothing about which values an option accepts. So the
 * agent did what the instruction could not prevent: it turned a concept from
 * the documentation, *requirement-task coverage*, into a command name.
 *
 * The same absence produced the rest of the session's friction. `task --help`
 * was refused although the general help promises that every command takes it.
 * `task` without `--status` answered *Missing required option --status* and
 * stopped there, naming neither the six values it accepts nor one correct line.
 *
 * All four are the same defect: the engine knows its own grammar and had no way
 * to say it. This table is that grammar, and `--help`, `capabilities`, the
 * missing-option error and the unknown-command suggestion are all readers of it.
 * One table, so they cannot drift into describing different products.
 *
 * WHAT IT DOES NOT DO
 * -------------------
 * It does not replace `COMMAND_OPTIONS`, which is the accept/refuse list and
 * stays the authority on what is allowed. This says which of those are
 * required, which take a closed set of values, and what one correct invocation
 * looks like. A command absent from here still gets help, synthesised from its
 * options; it simply gets a plainer page.
 */
interface CommandGrammar {
  /** One line: what the command is for. */
  summary: string;
  /** Options without which it refuses. */
  required?: string[];
  /** Options whose values are a closed set. */
  values?: Record<string, string[]>;
  /** One invocation that works, copied verbatim into the error. */
  example?: string;
  /** What a caller reaching for this command usually needs to know as well. */
  note?: string;
}

const COMMAND_GRAMMAR: Record<string, CommandGrammar> = {
  capabilities: {
    summary: "what this engine is and what its commands take. Read it before the first mutation.",
    example: "plangonaut capabilities",
  },
  version: { summary: "the engine version, one line.", example: "plangonaut version" },
  init: {
    summary: "create a project ledger in an empty folder.",
    required: ["project-root", "project-name", "project-mode", "interaction-mode", "owners-file", "operation-id"],
    values: { "project-mode": [...PROJECT_MODES].sort(), "interaction-mode": ["Guided", "Standard", "Expert"] },
    example: `plangonaut init --project-root . --project-name "My project" --project-mode Resume --interaction-mode Standard --owners-file owners.json --operation-id OP-INIT`,
  },
  requirement: {
    summary: "record or update a requirement: something the result has to do.",
    required: ["project-root", "id", "title", "status", "owner", "operation-id"],
    values: { status: ["DRAFT", "ACTIVE", "SUPERSEDED", "REJECTED"] },
    example: `plangonaut requirement --project-root . --id REQ-001 --title "Guests can book directly" --status ACTIVE --owner Ada --operation-id OP-REQ-001`,
  },
  decision: {
    summary: "record or update a decision: something that was chosen, and by whom.",
    required: ["project-root", "id", "title", "status", "owner", "operation-id"],
    values: { status: ["PROPOSED", "APPROVED", "SUPERSEDED", "REJECTED"] },
    example: `plangonaut decision --project-root . --id DEC-001 --title "MySQL on the existing plan" --status APPROVED --owner Ada --operation-id OP-DEC-001`,
  },
  task: {
    summary: "record or update a task: a piece of work somebody can pick up.",
    required: ["project-root", "id", "title", "status", "owner", "operation-id"],
    values: {
      status: ["BACKLOG", "READY", "IN_PROGRESS", "REVIEW", "DONE", "BLOCKED"],
      kind: ["IMPLEMENTATION", "DESIGN", "RESEARCH", "REVIEW", "ADMIN", "COORDINATION"],
    },
    example: `plangonaut task --project-root . --id TSK-001 --title "Booking hold on the channel API" --status READY --owner Ada --kind IMPLEMENTATION --requirements REQ-001 --acceptance "A hold is taken, expires in 15 minutes, and a second checkout for the same dates is refused" --verification "Integration test against the sandbox" --evidence-expected "Test run output attached as evidence" --operation-id OP-TSK-001`,
    note: "A task with no acceptance, no verification and no requirement of origin is a title. execution-readiness reports it as one.",
  },
  dependency: {
    summary: "link one requirement to one task, or one task to another.",
    required: ["project-root", "id", "from", "to", "type", "owner", "operation-id"],
    values: { type: ["REQUIRES", "BLOCKS", "RELATES_TO"] },
    example: `plangonaut dependency --project-root . --id DEP-001 --from REQ-001 --to TSK-001 --type REQUIRES --owner Ada --operation-id OP-DEP-001`,
    note:
      "One relation per command. Requirement-task coverage is built out of these, one link at a time: " +
      "three requirements covered by three tasks are three dependency commands with three ids and three " +
      "operation ids, not one command taking a list. There is no command that records coverage in bulk.",
  },
  risk: {
    summary: "record or update a risk, its severity and how it is being carried.",
    required: ["project-root", "id", "title", "severity", "status", "owner", "operation-id"],
    values: {
      severity: ["LOW", "MEDIUM", "HIGH", "CRITICAL"],
      status: ["IDENTIFIED", "MITIGATED", "ACCEPTED", "CLOSED"],
    },
    example: `plangonaut risk --project-root . --id RSK-001 --title "The channel API changes without notice" --severity HIGH --status IDENTIFIED --owner Ada --operation-id OP-RSK-001`,
    note: "A risk that is neither MITIGATED nor ACCEPTED needs a treatment as well as an owner; execution-readiness asks for one.",
  },
  record: {
    summary: "record the outcome of an interview module against a file.",
    required: ["project-root", "module", "status", "answer-file", "owner", "operation-id"],
    values: { status: ["CONFIRMED", "PARTIAL", "SKIPPED", "NOT_APPLICABLE"] },
    example: `plangonaut record --project-root . --module 7 --status CONFIRMED --answer-file docs/module-7-outcome.md --owner Ada --operation-id OP-MOD-7`,
    note: "The file is the module's outcome, not a summary of it. What an applicable module has to cover is in references/module-depth.md.",
  },
  gate: {
    summary: "record a gate as passed or failed, against evidence.",
    required: ["project-root", "id", "status", "evidence-file", "owner", "operation-id"],
    values: { status: ["PASSED", "FAILED"] },
    example: `plangonaut gate --project-root . --id G2 --status PASSED --evidence-file evidence_g2.md --owner Ada --operation-id OP-G2`,
  },
  "execution-intent": {
    summary: "declare whether this project is meant to be built or only defined.",
    required: ["project-root", "reason", "owner", "operation-id"],
    example: `plangonaut execution-intent --project-root . --execution --reason "The owner approved the build" --owner Ada --operation-id OP-INTENT`,
    note: "Exactly one of --execution or --definition-only. The engine never infers this from the absence of tasks.",
  },
  "execution-org": {
    summary: "record who executes the work, who reviews it and how it is handed over.",
    required: ["project-root", "executors", "mode", "reviewer", "concurrency", "handoff", "owner", "operation-id"],
    example: `plangonaut execution-org --project-root . --executors 2 --mode Agentic --reviewer Ada --concurrency "One task per component at a time" --handoff "Review passes before the next task starts" --integrator Ada --owner Ada --operation-id OP-ORG`,
  },
  "sufficiency-review": {
    summary: "record the semantic sufficiency review: what was checked, what is missing, and the conclusion.",
    required: ["project-root", "file", "owner", "operation-id"],
    example: `plangonaut sufficiency-review --project-root . --file review.json --owner Ada --operation-id OP-SUFF-1`,
    note:
      "The file is JSON. plangonaut sufficiency-review --template writes an empty one with every field and what it means. " +
      "The engine does not judge whether the review is intelligent; it checks that it exists, that it is current, and that " +
      "its conclusion does not contradict what the ledger records.",
  },
  validate: {
    summary: "mechanical integrity: schema, replay, references, digests. Not a judgement about the plan.",
    required: ["project-root"],
    example: "plangonaut validate --project-root . --strict",
  },
  "handoff-check": {
    summary: "could somebody who was not in the conversation pick this folder up?",
    required: ["project-root"],
    example: "plangonaut handoff-check --project-root .",
  },
  "execution-readiness": {
    summary: "is the work executable, or only defined? NOT_READY, CONDITIONALLY_READY or READY.",
    required: ["project-root"],
    example: "plangonaut execution-readiness --project-root .",
  },
  "read-record": {
    summary: "record that a source outside the governed root was read, and why.",
    required: ["project-root", "path", "purpose", "owner", "operation-id"],
    example: `plangonaut read-record --project-root . --path package.json --purpose "Confirm the framework major version against the plan" --owner Ada --operation-id OP-READ-1`,
  },
};

/** Levenshtein distance, capped: only used to decide whether to suggest at all. */
function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  let previous = Array.from({ length: cols }, (_unused, index) => index);
  for (let row = 1; row < rows; row += 1) {
    const current = [row];
    for (let col = 1; col < cols; col += 1) {
      current[col] = Math.min(
        previous[col] + 1,
        current[col - 1] + 1,
        previous[col - 1] + (a[row - 1] === b[col - 1] ? 0 : 1)
      );
    }
    previous = current;
  }
  return previous[cols - 1];
}

/**
 * Commands a mistyped or invented name might have meant.
 *
 * Nearness of spelling first, which catches a typo. Then the concepts an agent
 * is documented to need and might name after the idea rather than the command —
 * `coverage` is the one the pilot invented, and the answer to it is not a new
 * command but the one that already does the job.
 */
const CONCEPT_ALIASES: Record<string, { command: string; because: string }> = {
  coverage: {
    command: "dependency",
    because:
      "Requirement-task coverage is recorded as dependencies, one relation at a time: " +
      "--from REQ-ID --to TSK-ID --type REQUIRES. Several relations are several commands, " +
      "each with its own --id and --operation-id. There is no bulk coverage command.",
  },
  "requirement-coverage": { command: "dependency", because: "Coverage is dependencies: one requirement to one task per command." },
  link: { command: "dependency", because: "Links between records are dependencies." },
  trace: { command: "dependency", because: "Traceability between a requirement and a task is a dependency." },
  readiness: { command: "execution-readiness", because: "The readiness verdict is execution-readiness." },
  ready: { command: "execution-readiness", because: "The readiness verdict is execution-readiness." },
  check: { command: "validate", because: "Mechanical integrity is validate; handoff-check and execution-readiness answer the other two questions." },
  handoff: { command: "handoff-check", because: "The handoff question is handoff-check." },
  sufficiency: { command: "sufficiency-review", because: "The semantic review is recorded with sufficiency-review." },
  review: { command: "sufficiency-review", because: "The semantic review is recorded with sufficiency-review." },
  org: { command: "execution-org", because: "Who executes the work is execution-org." },
  organization: { command: "execution-org", because: "Who executes the work is execution-org." },
  organisation: { command: "execution-org", because: "Who executes the work is execution-org." },
};

function unknownCommandMessage(command: string): string {
  const known = Object.keys(COMMAND_OPTIONS).sort();
  const alias = CONCEPT_ALIASES[command.toLowerCase()];
  const near = known
    .map((name) => ({ name, distance: editDistance(command.toLowerCase(), name) }))
    .filter((entry) => entry.distance <= Math.max(2, Math.floor(command.length / 3)))
    .sort((first, second) => first.distance - second.distance)
    .slice(0, 3)
    .map((entry) => entry.name);

  const lines = [`Unknown command: ${command}. Nothing was read and nothing was written.`];
  if (alias) {
    lines.push(``, `You probably want: plangonaut ${alias.command}`, alias.because);
    const grammar = COMMAND_GRAMMAR[alias.command];
    if (grammar?.example) lines.push(``, grammar.example);
  } else if (near.length) {
    lines.push(``, `Did you mean: ${near.join(", ")}?`);
  }
  lines.push(``, `plangonaut capabilities lists every command and what it takes.`);
  return lines.join("\n");
}

/**
 * The help page for one command.
 *
 * Hand-written where a command has a flow worth explaining; synthesised from
 * the tables otherwise. Synthesised is not a placeholder — an agent needs the
 * option list and the accepted values far more than it needs prose, and those
 * are the parts that cannot go out of date here because they are the same
 * tables the parser uses.
 */
function synthesisedHelp(command: string): string {
  const options = COMMAND_OPTIONS[command];
  if (!options) return "";
  const grammar = COMMAND_GRAMMAR[command];
  const requiredOptions = new Set(grammar?.required ?? []);
  const lines: string[] = [];
  lines.push(`plangonaut ${command}${grammar ? ` — ${grammar.summary}` : ""}`);
  lines.push(``);
  if (!options.length) {
    lines.push(`Takes no options.`);
  } else {
    lines.push(`Options:`);
    for (const option of options) {
      const values = grammar?.values?.[option];
      const marks = [requiredOptions.has(option) ? "required" : "optional"];
      if (values) marks.push(`one of: ${values.join(", ")}`);
      lines.push(`  --${option.padEnd(22)} ${marks.join(" · ")}`);
    }
  }
  if (grammar?.example) lines.push(``, `Example:`, `  ${grammar.example}`);
  if (grammar?.note) lines.push(``, grammar.note);
  return lines.join("\n");
}

function anyCommandHelp(command: string): string | null {
  const written = COMMAND_HELP[command];
  if (written) return written;
  const synthesised = synthesisedHelp(command);
  return synthesised || null;
}

/**
 * A missing required option, said so that the next attempt succeeds.
 *
 * *Missing required option --status* is true and leaves the caller to find the
 * six accepted values somewhere else. The pilot's agent did not find them: it
 * guessed, was refused again, and guessed again.
 */
function missingOptionMessage(command: string, key: string): string {
  const grammar = COMMAND_GRAMMAR[command];
  const values = grammar?.values?.[key];
  const lines = [`Missing required option --${key}. Nothing was written.`];
  if (values) lines.push(`Accepted values: ${values.join(", ")}.`);
  if (grammar?.required?.length) lines.push(`${command} requires: ${grammar.required.map((item) => `--${item}`).join(", ")}.`);
  if (grammar?.example) lines.push(``, `A correct call:`, `  ${grammar.example}`);
  lines.push(``, `plangonaut ${command} --help repeats this.`);
  return lines.join("\n");
}

function commandHelp(command: string): string | null {
  return COMMAND_HELP[command] ?? null;
}

function help(): void {
  console.log("Mutation requirements: pass --operation-id OP-ID to every mutating command. For doc-save, first run doc-diff and pass its confirmation_token as --confirm-token TOKEN.\nAny command takes --help for its own options and, where there is one, its full flow: plangonaut doc-save --help.\n");
  console.log(`Plangonaut ${VERSION}\n\nUsage: plangonaut <command> [options]\n\nAlmost every command that changes the project requires --operation-id <unique-id>,\n3 to 128 characters. It is how a retried command is recognised as the same operation\nrather than applied twice, so it is required rather than generated, and it is omitted\nfrom the lines below only because it belongs to nearly all of them.\n\nThe exception is migrate-brand. It carries its own migration id and its own receipt,\nand is resumed or rolled back by that id rather than retried under an operation id, so\nit neither requires nor uses one. --operation-id is accepted there, as it is on every\ncommand, and has no effect.\n\nThe first command needs an owners file. It is one JSON object with these five keys,\neach naming the person accountable for that kind of decision:\n\n  {\"product\":\"Ada\",\"technical\":\"Ada\",\"budget\":\"Ada\",\"safety\":\"Ada\",\"release\":\"Ada\"}\n\nSave it anywhere and pass its path to --owners-file; the same person may hold more\nthan one role. An unknown key is refused, and so is a missing or empty one. What the\nroles mean, and when they matter, is in skills/plangonaut/references/user-guide.md.\n\nCommands:\n  capabilities\n  init --project-root . --project-name NAME --project-mode Resume --interaction-mode Standard --owners-file owners.json\n  status --project-root .\n  next --project-root . [--count N]                       (one block; default 5, or what the project recorded)\n  next --project-root . --count N --remember --owner NAME  (record that block size as the project's own)\n  resume --project-root .\n  record --project-root . --module N --status CONFIRMED --answer-file FILE --owner NAME\n  decision --project-root . --id DEC-ID --title TEXT --status APPROVED --owner NAME [--expected-revision N]\n  requirement --project-root . --id REQ-ID --title TEXT --status ACTIVE --owner NAME [--expected-revision N]\n  task --project-root . --id TSK-ID --title TEXT --status READY --owner NAME [--expected-revision N]\n  dependency --project-root . --id DEP-ID --from REQ-ID --to TSK-ID --type REQUIRES --owner NAME [--expected-revision N]\n  risk --project-root . --id RSK-ID --title TEXT --severity HIGH --status IDENTIFIED --owner NAME [--expected-revision N]\n  evidence --project-root . --id EVD-ID --file FILE --owner NAME [--expected-revision N]\n  agent --project-root . --id AGT-ID --name TEXT --status ACTIVE --owner NAME [--expected-revision N]\n  checkpoint --project-root . --id CHK-ID --name TEXT --owner NAME [--next-action TEXT] [--expected-revision N]\n  blocker-record --project-root . --id BLK-ID --title TEXT --reason TEXT --owner NAME [--evidence-file FILE] [--expected-revision N]\n  blocker-resolve --project-root . --id BLK-ID --resolution TEXT --owner NAME --expected-revision N [--evidence-file FILE]\n  blocker-verify-none --project-root . --owner NAME [--note TEXT]   (records that somebody looked and found none open)\n  override --project-root . --instruction-file FILE --owner NAME [--reason TEXT]\n  re-record --project-root . --kind override|gate --id OVR-ID|G2 --source-file FILE --owner NAME --reason TEXT\n  reconcile --project-root . --override-id ID --evidence-file FILE --owner NAME [--next-action TEXT] [--replace-human-next-action]\n  forecast --project-root . --owner NAME --phase TEXT --known-work TEXT --conditional-work TEXT --questions MIN-MAX --operations MIN-MAX --cycles MIN-MAX --confidence ALTA|MEDIA|BASSA --confidence-reason TEXT --cycle-state REGOLARE|IN_ESPANSIONE|RISCHIO_LOOP|BLOCCATO [--change-reason TEXT: required from the second forecast on, refused on the first] [--expected-revision N]\n  forecast --project-root .    (reads the recorded forecast; ranges only, never a percentage)\n  gate --project-root . --id G2 --status PASSED --evidence-file FILE --owner NAME\n  doc-diff --project-root . --id ART-123 --base-path docs/design.md --content-file temp.md --owner NAME [--expected-revision N --expected-hash HASH]\n  doc-mark-deletion --project-root . --id ART-123 --target TEXT --reason-file FILE --content-file FILE --owner NAME [--expected-revision N --expected-hash HASH]\n  doc-save --project-root . --id ART-123 --base-path docs/design.md --content-file temp.md --owner NAME --confirm-token TOKEN [--sources DEC-1] [--expected-revision N --expected-hash HASH]\n  doc-history --project-root . --id ART-123\n  doc-restore --project-root . --id ART-123 --revision N --owner NAME [--expected-revision N --expected-hash HASH]\n  doc-finalize --project-root . --id ART-123 --owner NAME [--expected-revision N --expected-hash HASH] [--accept-base-overwrite]\n  qa-ask --project-root . --id QNA-0001 --question TEXT --rationale TEXT --owner NAME [--module N] [--agent NAME] [--planned]
  qa-answer --project-root . --id QNA-0001 --answer-file FILE --owner NAME [--agent NAME]
  qa-settle --project-root . --id QNA-0001 --interpretation TEXT --reply-file FILE --owner NAME [--consequences DEC-1,REQ-2] [--documents docs/a.md] [--open-points TEXT] [--next-id QNA-0002] [--next-question TEXT]
  qa-close --project-root . --id QNA-0001 --kind deferred|skipped|invalidated --reason TEXT --owner NAME
  qa-supersede --project-root . --id QNA-0001 --new-id QNA-0009 --question TEXT --rationale TEXT --reason TEXT --owner NAME
  qa-log --project-root . [--open] [--last] [--json] [--id QNA-0001] [--regenerate]
  context-pack --project-root . [--output session.md]\n  validate --project-root . [--strict]\n  govern --project-root . --exclude docs/appunti.md --reason TEXT --owner NAME\n  govern --project-root . --include docs/appunti.md --owner NAME\n  migrate --project-root .\n  migrate-backups --project-root . [--apply]        (move a pre-0.3.0-alpha.5 backups/ directory under the ledger)\n  migrate-brand --project-root . --dry-run                   (what a brand migration would do; writes nothing)\n  migrate-brand --project-root .                             (.beave -> .plangonaut, verified backup and receipt)\n  migrate-brand --project-root . --resume                    (finish one that was interrupted)\n  migrate-brand --project-root . --rollback MIG-ID           (undo one, verifying receipt and backup)\n  migrate-brand --project-root . --rollback MIG-ID --discard-changes  (and throw away what was recorded since)\n  replay --project-root . [--verify]                     (rebuild the state from the events and compare)\n  replay --project-root . --repair --operation-id OP-ID  (put the rebuilt state back, keeping a backup)\n  baseline --project-root . --reason TEXT --owner NAME --operation-id OP-ID\n  recover --project-root . [--apply]                     (interrupted operations: what they are, and finish them)\n  unlock --project-root . [--force]                      (who holds the project lock, and release an abandoned one)\n  project-export --project-root . --output-dir DIR\n  project-verify --package-dir DIR\n  doc-lock --project-root . [--id ART-ID] [--json]            (who is editing a governed document, and since when)\n  doc-lock-acquire --project-root . --id ART-ID --owner NAME --session S [--pid N] --operation-id ID\n  doc-lock-release --project-root . --id ART-ID --owner NAME --operation-id ID\n  doc-lock-recover --project-root . --id ART-ID --owner NAME --operation-id ID   (a session on this host that has ended)\n  doc-lock-force-release --project-root . --id ART-ID --owner NAME --reason TEXT --operation-id ID\n  handoff-check --project-root . [--json]                (is this folder enough for somebody who was not here?)\n  execution-readiness --project-root . [--json]          (is the work executable, or only defined?)\n  compat-check --project-root . [--json] [--writer-engine NAME --writer-version V --writer-schema N --writer-event-format N --writer-reads-formats 1,2]\n  execution-intent --project-root . --execution|--definition-only --reason TEXT --owner NAME --operation-id ID\n  execution-org --project-root . --executors N --mode TEXT --reviewer NAME --concurrency TEXT --handoff TEXT [--integrator NAME] --owner NAME --operation-id ID\n  read-record --project-root . --path FILE --purpose TEXT [--agent NAME] [--conclusions TEXT] [--used-by IDS] --owner NAME --operation-id ID\n  project-import --package-dir DIR --project-root NEW_DIR\n  export --target portable|codex|claude|gemini|agy --output-dir DIR\n  install --target codex|claude|gemini|agy|all [--scope project|workspace|user] [--project-root DIR] [--dry-run]\n  verify-install --target codex|claude|gemini|agy [--scope project|workspace|user] [--project-root DIR]\n  version`);
}

/**
 * Commands whose stdout **is** a JSON document.
 *
 * `status` has always printed JSON and takes no `--json` to ask for it; every
 * other command that can is asked with the flag. Both go through the same
 * function so that "is this channel JSON?" has exactly one answer, and a command
 * added to one list cannot be forgotten in the other.
 */
const ALWAYS_JSON_COMMANDS = new Set(["status"]);

function jsonChannel(argv: string[]): boolean {
  const command = argv[0];
  return ALWAYS_JSON_COMMANDS.has(command) || argv.includes("--json");
}

/**
 * A refusal as a document, for the callers that cannot read a sentence.
 *
 * Printed on **stdout**, alone, and nothing goes to stderr in this mode: a
 * caller that merges the two streams must still get one parseable document.
 * That is the whole point — mixing an explanation into the JSON channel is the
 * defect this replaces, in the other direction.
 *
 * `blockers_assurance: "UNTRUSTED"` rides along on an untrusted project because
 * that is the fourth value of the vocabulary `status` already publishes, and it
 * was until now unreachable: the one command that could report it refused such a
 * project outright. A consumer that switches on `blockers_assurance` now sees
 * all four.
 */
/* ------------------------------------------------------------ migrate-brand */

/**
 * `.beave/` to `.plangonaut/`, explicitly, verifiably, and reversibly.
 *
 * Three properties shape everything below, and each of them is a decision that
 * could have gone the other way:
 *
 * **A project at rest has exactly one state directory.** The first draft of the
 * contract said a completed migration *retains* `.beave/`, and also that a
 * project holding both directories is ambiguous and refused. That is a migration
 * whose success condition is the failure state — it would have ended by making
 * the project unusable by the engine that migrated it. The old bytes are kept,
 * but under `.plangonaut/migrations/<id>/legacy-backup/`, where no resolver
 * looks for state.
 *
 * **The staging directory is not called `.plangonaut`.** A half-built ledger
 * that counts as an active state makes the project ambiguous for the duration of
 * its own migration, and an interruption makes it ambiguous permanently.
 * `.plangonaut-migration-<id>/` is recognised as staging and never as state.
 *
 * **The phase is written before it is attempted, not after.** An interrupted
 * migration is then recognised by *which* phase it stopped in, rather than
 * inferred from what happens to be on disk — and the two states that look
 * identical on disk, "staged but not swapped" and "swapped but not cleaned",
 * need opposite remedies.
 */

type MigrationPhase = "starting" | "staging" | "verified" | "swapped" | "cleaning";

interface MigrationMarker {
  migration_id: string;
  phase: MigrationPhase;
  started_at: string;
  staging: string;
  engine_version: string;
}

interface MigrationReceipt {
  migration_id: string;
  engine_version: string;
  source_version: string;
  target_version: string;
  source_format: string;
  target_format: string;
  migrated_at: string;
  files_migrated: string[];
  files_preserved: string[];
  references_updated: { file: string; from: string; to: string; count: number }[];
  source_digest: string;
  target_digest: string;
  backup_digest: string;
  file_digests: Record<string, string>;
  verification: { schema: string; digests: string; replay: string };
  rollback: { state: "available" | "applied" | "refused"; at: string | null; reason: string | null };
}

const MIGRATIONS_DIR = "migrations";
const RECEIPT_NAME = "receipt.json";
const LEGACY_BACKUP = "legacy-backup";

function migrationMarkerPath(root: string): string {
  return path.join(root, MIGRATION_MARKER);
}

function readMigrationMarker(root: string): MigrationMarker | null {
  const location = migrationMarkerPath(root);
  if (!fs.existsSync(location)) return null;
  try {
    return JSON.parse(fs.readFileSync(location, "utf8")) as MigrationMarker;
  } catch {
    throw new PlangonautError(
      `${MIGRATION_MARKER} is there but cannot be read, so what a migration was doing here cannot be established.\n` +
        `Nothing was changed. Inspect it by hand before running anything else.`,
      "MIGRATION_INCOMPLETE",
    );
  }
}

function writeMigrationMarker(root: string, marker: MigrationMarker): void {
  fs.writeFileSync(migrationMarkerPath(root), `${JSON.stringify(marker, null, 2)}\n`, "utf8");
}

/** Every file under a directory, relative, sorted, with `/` separators. */
function treeFiles(directory: string): string[] {
  const out: string[] = [];
  const visit = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) out.push(path.relative(directory, full).split(path.sep).join("/"));
    }
  };
  if (fs.existsSync(directory)) visit(directory);
  return out.sort();
}

/**
 * The digest that answers "has this project moved on since the migration?".
 *
 * Over the durable ledger and **not** over `migrations/`, which is the
 * migration's own bookkeeping. The first version hashed the whole tree, and the
 * receipt is written into that tree after the digest is taken — so every
 * rollback refused, on a project nobody had touched, with a message accusing the
 * user of changes they had not made. A guard that cries wolf on its own output
 * is worse than no guard: it teaches people to pass `--discard-changes`.
 */
function stateDigest(directory: string): string {
  const hash = crypto.createHash("sha256");
  for (const relative of treeFiles(directory)) {
    if (relative === MIGRATIONS_DIR || relative.startsWith(`${MIGRATIONS_DIR}/`)) continue;
    if (relative === "lock.json") continue;
    // Machine-local bookkeeping about what has already been printed, not project
    // state: see `recordNotice`.
    if (relative === NOTICES_FILE) continue;
    const one = crypto.createHash("sha256").update(fs.readFileSync(path.join(directory, relative))).digest("hex");
    hash.update(relative).update("\u0000").update(one).update("\u0000");
  }
  return hash.digest("hex");
}

/** One digest over a whole tree: every relative path and the bytes under it. */
function treeDigest(directory: string): { digest: string; files: Record<string, string> } {
  const files: Record<string, string> = {};
  const hash = crypto.createHash("sha256");
  for (const relative of treeFiles(directory)) {
    const bytes = fs.readFileSync(path.join(directory, relative));
    const one = crypto.createHash("sha256").update(bytes).digest("hex");
    files[relative] = one;
    hash.update(relative).update("\u0000").update(one).update("\u0000");
  }
  return { digest: hash.digest("hex"), files };
}

/**
 * The references a migration is allowed to rewrite.
 *
 * Only the ones that name the state directory **as a path**. Everything else in
 * the ledger — decisions, answers, timestamps, digests of project documents,
 * overrides, the event chain — is copied byte for byte, because rewriting any of
 * it would make the migrated project a different project that happens to look
 * similar.
 *
 * `.beave/` appears inside the ledger in exactly two shapes: as a recorded path
 * to a document archived under the state directory, and inside prose the engine
 * wrote. Both are rewritten; a path a *user* recorded pointing into `.beave/`
 * is rewritten too, because the directory it names is about to stop existing.
 */
function rewriteStateReferences(text: string): { text: string; count: number } {
  const from = `${LEGACY_STATE_DIR}/`;
  const to = `${STATE_DIR}/`;
  const backslash = `${LEGACY_STATE_DIR}\\`;
  const backslashTo = `${STATE_DIR}\\`;
  let count = 0;
  let out = text;
  for (const [a, b] of [[from, to], [backslash, backslashTo]] as const) {
    let index = out.indexOf(a);
    while (index !== -1) {
      count += 1;
      out = out.slice(0, index) + b + out.slice(index + a.length);
      index = out.indexOf(a, index + b.length);
    }
  }
  return { text: out, count };
}

/** Files whose text may carry a path into the state directory. */
const MIGRATABLE_TEXT = new Set([".json", ".jsonl", ".md", ".txt"]);

interface MigrationPlan {
  root: string;
  source: string;
  files: string[];
  bytes: number;
  references: { file: string; from: string; to: string; count: number }[];
  blockers: string[];
  migrationId: string;
  staging: string;
  backup: string;
  sourceVersion: string;
  engineVersion: string;
}

/**
 * Everything the migration would do, computed without touching the filesystem.
 *
 * The same function backs `--dry-run` and the real run, so what the preview
 * shows is what the migration acts on rather than a second implementation that
 * agrees with it by inspection.
 */
function planBrandMigration(root: string, migrationId: string): MigrationPlan {
  const source = path.join(root, LEGACY_STATE_DIR);
  const blockers: string[] = [];

  if (fs.existsSync(path.join(root, STATE_DIR))) {
    blockers.push(
      `${STATE_DIR}/ already exists. A migration creates it; it does not merge into one. ` +
        `If that directory is an earlier attempt, move it aside and run this again.`,
    );
  }
  if (!fs.existsSync(source)) {
    blockers.push(`There is no ${LEGACY_STATE_DIR}/ here, so there is nothing to migrate.`);
  }
  if (fs.existsSync(lockFile(root))) {
    blockers.push(`The project is locked. A migration must not run while another command holds it.`);
  }

  const files = treeFiles(source);
  let bytes = 0;
  const references: { file: string; from: string; to: string; count: number }[] = [];
  for (const relative of files) {
    const full = path.join(source, relative);
    bytes += fs.statSync(full).size;
    if (!MIGRATABLE_TEXT.has(path.extname(relative).toLowerCase())) continue;
    const original = fs.readFileSync(full, "utf8");
    const { count } = rewriteStateReferences(original);
    if (count > 0) {
      references.push({ file: `${LEGACY_STATE_DIR}/${relative}`, from: `${LEGACY_STATE_DIR}/`, to: `${STATE_DIR}/`, count });
    }
  }

  let sourceVersion = "not recorded";
  const statePath = path.join(source, "state.json");
  if (fs.existsSync(statePath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
      sourceVersion = String(parsed?.beave_version ?? parsed?.plangonaut_version ?? "not recorded");
    } catch {
      blockers.push(`${LEGACY_STATE_DIR}/state.json cannot be parsed. Repair the project before migrating it.`);
    }
  } else if (fs.existsSync(source)) {
    blockers.push(`${LEGACY_STATE_DIR}/state.json is missing. There is no state here to migrate.`);
  }

  return {
    root,
    source,
    files,
    bytes,
    references,
    blockers,
    migrationId,
    staging: path.join(root, `${MIGRATION_STAGING_PREFIX}${migrationId}`),
    backup: `${STATE_DIR}/${MIGRATIONS_DIR}/${migrationId}/${LEGACY_BACKUP}/`,
    sourceVersion,
    engineVersion: VERSION,
  };
}

function printMigrationPlan(plan: MigrationPlan): void {
  console.log(`Brand migration preview for ${plan.root}`);
  console.log("");
  console.log(`  source format      ${LEGACY_STATE_DIR}/ (legacy)`);
  console.log(`  target format      ${STATE_DIR}/`);
  console.log(`  source version     ${plan.sourceVersion}`);
  console.log(`  engine             ${plan.engineVersion}`);
  console.log(`  migration id       ${plan.migrationId}`);
  console.log("");
  console.log(`  files              ${plan.files.length}`);
  console.log(`  bytes              ${plan.bytes}`);
  console.log(`  staging            ${path.basename(plan.staging)}/`);
  console.log(`  backup             ${plan.backup}`);
  console.log("");
  console.log(`  preconditions checked: ${STATE_DIR}/ absent, ${LEGACY_STATE_DIR}/ present, no lock held,`);
  console.log(`                         state parses, no migration already in flight`);
  console.log("");
  if (plan.references.length === 0) {
    console.log("  no reference to the state directory is recorded inside the ledger");
  } else {
    console.log(`  references that would be rewritten (${plan.references.reduce((sum, item) => sum + item.count, 0)}):`);
    for (const item of plan.references) console.log(`    ${item.file}: ${item.count} × ${item.from} → ${item.to}`);
  }
  console.log("");
  if (plan.blockers.length) {
    console.log("  BLOCKED:");
    for (const blocker of plan.blockers) console.log(`    - ${blocker}`);
  } else {
    console.log("  no blockers");
  }
  console.log("");
  console.log("Nothing was written. Run the same command without --dry-run to migrate.");
}

/** Copy the source ledger into staging, rewriting only state-directory paths. */
function stageMigration(plan: MigrationPlan): { migrated: string[]; preserved: string[] } {
  fs.mkdirSync(plan.staging, { recursive: true });
  const migrated: string[] = [];
  const preserved: string[] = [];
  const rewritten = new Set(plan.references.map((item) => item.file.slice(LEGACY_STATE_DIR.length + 1)));

  for (const relative of plan.files) {
    const from = path.join(plan.source, relative);
    const to = path.join(plan.staging, relative);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    if (rewritten.has(relative)) {
      const { text } = rewriteStateReferences(fs.readFileSync(from, "utf8"));
      fs.writeFileSync(to, text, "utf8");
      migrated.push(relative);
    } else {
      // Byte for byte. Everything the project decided, asked, answered and
      // recorded arrives unchanged, which is what makes this a migration of the
      // directory rather than of the history inside it.
      fs.copyFileSync(from, to);
      preserved.push(relative);
    }
  }
  return { migrated, preserved };
}

/**
 * The old tree, kept where the resolver does not look, and provable.
 *
 * Under `migrations/<id>/legacy-backup/` inside the new state directory: it
 * travels with the project, it is covered by the same reserved-path rules, and
 * nothing counts it as a second active ledger.
 */
function writeLegacyBackup(plan: MigrationPlan): { digest: string; files: Record<string, string> } {
  const destination = path.join(plan.staging, MIGRATIONS_DIR, plan.migrationId, LEGACY_BACKUP);
  fs.mkdirSync(destination, { recursive: true });
  for (const relative of plan.files) {
    const to = path.join(destination, relative);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(plan.source, relative), to);
  }
  return treeDigest(destination);
}

function receiptPath(root: string, migrationId: string): string {
  return path.join(root, STATE_DIR, MIGRATIONS_DIR, migrationId, RECEIPT_NAME);
}

/**
 * Verify what was staged against what it came from.
 *
 * Three questions, answered separately because they fail for different reasons:
 * does the state still parse and satisfy the schema; do the bytes that were not
 * meant to change still match; does the history still replay.
 */
function verifyStaging(plan: MigrationPlan, preserved: string[]): { schema: string; digests: string; replay: string } {
  const statePath = path.join(plan.staging, "state.json");
  let parsed: any;
  try {
    parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch (error) {
    throw new PlangonautError(`The staged state does not parse: ${String((error as any)?.message ?? error)}. Nothing was swapped.`);
  }
  if (!parsed?.project?.name) {
    throw new PlangonautError("The staged state has no project name, so it is not the state that was copied. Nothing was swapped.");
  }

  for (const relative of preserved) {
    const before = crypto.createHash("sha256").update(fs.readFileSync(path.join(plan.source, relative))).digest("hex");
    const after = crypto.createHash("sha256").update(fs.readFileSync(path.join(plan.staging, relative))).digest("hex");
    if (before !== after) {
      throw new PlangonautError(
        `${relative} was supposed to be copied unchanged and is not identical in the staging tree. Nothing was swapped.`,
      );
    }
  }

  const events = path.join(plan.staging, "events.jsonl");
  let replay = "no history recorded";
  if (fs.existsSync(events)) {
    const lines = fs.readFileSync(events, "utf8").split(/\r?\n/).filter((line) => line.trim().length > 0);
    for (const [index, line] of lines.entries()) {
      try {
        JSON.parse(line);
      } catch {
        throw new PlangonautError(`Line ${index + 1} of the staged events is not valid JSON. Nothing was swapped.`);
      }
    }
    replay = `${lines.length} events parse`;
  }

  return { schema: "state parses and names its project", digests: `${preserved.length} files identical`, replay };
}

/**
 * Do it.
 *
 * The order is the recoverable one: everything that can be discarded happens
 * before anything that cannot, and the marker names the next phase **before**
 * that phase is attempted.
 */
function runBrandMigration(root: string, plan: MigrationPlan): void {
  const marker: MigrationMarker = {
    migration_id: plan.migrationId,
    phase: "starting",
    started_at: now(),
    staging: path.basename(plan.staging),
    engine_version: plan.engineVersion,
  };
  writeMigrationMarker(root, marker);

  marker.phase = "staging";
  writeMigrationMarker(root, marker);
  const { migrated, preserved } = stageMigration(plan);
  const backup = writeLegacyBackup(plan);
  const sourceTree = treeDigest(plan.source);

  const verification = verifyStaging(plan, preserved);
  marker.phase = "verified";
  writeMigrationMarker(root, marker);

  const receipt: MigrationReceipt = {
    migration_id: plan.migrationId,
    engine_version: plan.engineVersion,
    source_version: plan.sourceVersion,
    target_version: plan.engineVersion,
    source_format: LEGACY_STATE_DIR,
    target_format: STATE_DIR,
    migrated_at: now(),
    files_migrated: migrated,
    files_preserved: preserved,
    references_updated: plan.references,
    source_digest: sourceTree.digest,
    target_digest: "",
    backup_digest: backup.digest,
    file_digests: backup.files,
    verification,
    rollback: { state: "available", at: null, reason: null },
  };
  const receiptInStaging = path.join(plan.staging, MIGRATIONS_DIR, plan.migrationId, RECEIPT_NAME);
  fs.mkdirSync(path.dirname(receiptInStaging), { recursive: true });
  fs.writeFileSync(receiptInStaging, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");

  // The swap. From here the project's state directory is the new one.
  marker.phase = "swapped";
  writeMigrationMarker(root, marker);
  fs.renameSync(plan.staging, path.join(root, STATE_DIR));

  // The old directory goes only after its bytes are provably inside the new one.
  marker.phase = "cleaning";
  writeMigrationMarker(root, marker);
  const kept = treeDigest(path.join(root, STATE_DIR, MIGRATIONS_DIR, plan.migrationId, LEGACY_BACKUP));
  if (kept.digest !== backup.digest) {
    throw new PlangonautError(
      `The backup inside ${STATE_DIR}/ does not match what was written. ${LEGACY_STATE_DIR}/ has been left where it is.`,
      "MIGRATION_INCOMPLETE",
    );
  }
  fs.rmSync(plan.source, { recursive: true, force: true });

  const finalDigest = stateDigest(path.join(root, STATE_DIR));
  receipt.target_digest = finalDigest;
  fs.writeFileSync(receiptPath(root, plan.migrationId), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");

  fs.rmSync(migrationMarkerPath(root), { force: true });

  console.log(`Migrated ${root} from ${LEGACY_STATE_DIR}/ to ${STATE_DIR}/.`);
  console.log("");
  console.log(`  migration id      ${plan.migrationId}`);
  console.log(`  files migrated    ${migrated.length} (references rewritten)`);
  console.log(`  files preserved   ${preserved.length} (byte for byte)`);
  console.log(`  source digest     ${sourceTree.digest}`);
  console.log(`  target digest     ${finalDigest}`);
  console.log(`  backup            ${STATE_DIR}/${MIGRATIONS_DIR}/${plan.migrationId}/${LEGACY_BACKUP}/`);
  console.log(`  backup digest     ${backup.digest}`);
  console.log(`  receipt           ${STATE_DIR}/${MIGRATIONS_DIR}/${plan.migrationId}/${RECEIPT_NAME}`);
  console.log("");
  console.log(`Next: run \`plangonaut validate --project-root .\` to confirm, and \`plangonaut resume --project-root .\` to continue.`);
  console.log(`To undo: \`plangonaut migrate-brand --project-root . --rollback ${plan.migrationId}\``);
}

/**
 * Finish a migration that stopped, from whichever phase it stopped in.
 *
 * The two phases that look identical on disk need opposite work, which is the
 * whole reason the marker records a phase rather than the engine inferring one:
 * `verified` has a staging tree to promote, `swapped` has an old directory to
 * retire. Guessing between them by looking at the filesystem would eventually
 * guess wrong on a project nobody could reconstruct.
 */
function resumeBrandMigration(root: string, marker: MigrationMarker): void {
  const staging = path.join(root, marker.staging);
  const target = path.join(root, STATE_DIR);
  const source = path.join(root, LEGACY_STATE_DIR);

  if (marker.phase === "starting" || marker.phase === "staging") {
    throw new PlangonautError(
      `The migration stopped at phase "${marker.phase}", before anything was verified. There is nothing to finish.\n` +
        `Discard it and start again:\n  plangonaut migrate-brand --project-root . --rollback ${marker.migration_id}`,
      "MIGRATION_INCOMPLETE",
    );
  }

  if (marker.phase === "verified") {
    if (!fs.existsSync(staging)) {
      throw new PlangonautError(
        `The marker says the staging was verified, and ${marker.staging}/ is not there. Nothing can be finished from this state.`,
        "MIGRATION_INCOMPLETE",
      );
    }
    marker.phase = "swapped";
    writeMigrationMarker(root, marker);
    fs.renameSync(staging, target);
  }

  const receipt = JSON.parse(fs.readFileSync(receiptPath(root, marker.migration_id), "utf8")) as MigrationReceipt;
  const kept = treeDigest(path.join(target, MIGRATIONS_DIR, marker.migration_id, LEGACY_BACKUP));
  if (kept.digest !== receipt.backup_digest) {
    throw new PlangonautError(
      `The backup inside ${STATE_DIR}/ does not match its receipt, so ${LEGACY_STATE_DIR}/ will not be removed.\n` +
        `Nothing was changed.`,
      "MIGRATION_INCOMPLETE",
    );
  }
  if (fs.existsSync(source)) {
    marker.phase = "cleaning";
    writeMigrationMarker(root, marker);
    fs.rmSync(source, { recursive: true, force: true });
  }

  receipt.target_digest = stateDigest(target);
  fs.writeFileSync(receiptPath(root, marker.migration_id), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  fs.rmSync(migrationMarkerPath(root), { force: true });
  console.log(`Migration ${marker.migration_id} finished. ${STATE_DIR}/ is the only state directory here.`);
}

/**
 * Put it back, and refuse rather than half-do it.
 *
 * Rollback is where a migration tool is most dangerous, because it runs when
 * somebody is already unhappy. So every check below refuses instead of
 * repairing: a receipt that does not parse, a backup whose digest moved, or a
 * `.plangonaut/` that has been written to since the migration all stop the
 * command. The last of those is the one that matters most — rolling back over
 * work done after the migration would delete it without mentioning it.
 */
function rollbackBrandMigration(root: string, migrationId: string, discardChanges: boolean): void {
  const target = path.join(root, STATE_DIR);
  const source = path.join(root, LEGACY_STATE_DIR);
  const marker = readMigrationMarker(root);

  // An interrupted migration that never swapped: discard the staging and stop.
  if (marker && (marker.phase === "starting" || marker.phase === "staging")) {
    const staging = path.join(root, marker.staging);
    if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
    fs.rmSync(migrationMarkerPath(root), { force: true });
    console.log(`Discarded the unfinished migration ${marker.migration_id}. ${LEGACY_STATE_DIR}/ is untouched.`);
    return;
  }
  if (marker && marker.phase === "verified") {
    const staging = path.join(root, marker.staging);
    if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
    fs.rmSync(migrationMarkerPath(root), { force: true });
    console.log(`Discarded the verified but unswapped migration ${marker.migration_id}. ${LEGACY_STATE_DIR}/ is untouched.`);
    return;
  }

  const location = receiptPath(root, migrationId);
  if (!fs.existsSync(location)) {
    throw new PlangonautError(
      `No receipt for migration ${migrationId} at ${STATE_DIR}/${MIGRATIONS_DIR}/${migrationId}/${RECEIPT_NAME}.\n` +
        `A rollback without its receipt cannot prove what it would be restoring. Nothing was changed.`,
    );
  }
  let receipt: MigrationReceipt;
  try {
    receipt = JSON.parse(fs.readFileSync(location, "utf8")) as MigrationReceipt;
  } catch (error) {
    throw new PlangonautError(`The receipt for ${migrationId} cannot be read: ${String((error as any)?.message ?? error)}. Nothing was changed.`);
  }

  const backupDir = path.join(target, MIGRATIONS_DIR, migrationId, LEGACY_BACKUP);
  if (!fs.existsSync(backupDir)) {
    throw new PlangonautError(`The backup for ${migrationId} is not there. Nothing was changed.`);
  }
  const backup = treeDigest(backupDir);
  if (backup.digest !== receipt.backup_digest) {
    throw new PlangonautError(
      `The backup for ${migrationId} does not match the digest its receipt records.\n` +
        `  recorded ${receipt.backup_digest}\n  found    ${backup.digest}\n` +
        `Restoring it would restore something other than what was migrated. Nothing was changed.`,
    );
  }

  // Has the project moved on since the migration?
  const current = stateDigest(target);
  if (receipt.target_digest && current !== receipt.target_digest && !discardChanges) {
    throw new PlangonautError(
      `${STATE_DIR}/ has changed since migration ${migrationId}.\n` +
        `  at migration ${receipt.target_digest}\n  now          ${current}\n` +
        `A rollback would discard everything recorded since. If that is what you want, say so:\n` +
        `  plangonaut migrate-brand --project-root . --rollback ${migrationId} --discard-changes\n` +
        `Nothing was changed.`,
    );
  }

  if (fs.existsSync(source)) {
    throw new PlangonautError(
      `${LEGACY_STATE_DIR}/ already exists, so a rollback would produce two state directories. Nothing was changed.`,
      "PROJECT_STATE_AMBIGUOUS",
    );
  }

  // Rebuild in staging, verify, then swap — the same order as the migration.
  const staging = path.join(root, `${MIGRATION_STAGING_PREFIX}${migrationId}-rollback`);
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  for (const relative of treeFiles(backupDir)) {
    const to = path.join(staging, relative);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(backupDir, relative), to);
  }
  const rebuilt = treeDigest(staging);
  if (rebuilt.digest !== receipt.backup_digest) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw new PlangonautError(`The rebuilt ${LEGACY_STATE_DIR}/ does not match the backup digest. Nothing was changed.`);
  }

  const retired = path.join(root, `${MIGRATION_STAGING_PREFIX}${migrationId}-retired`);
  fs.rmSync(retired, { recursive: true, force: true });
  fs.renameSync(target, retired);
  fs.renameSync(staging, source);
  fs.rmSync(retired, { recursive: true, force: true });

  console.log(`Rolled back migration ${migrationId}. ${LEGACY_STATE_DIR}/ is the only state directory here.`);
  console.log(`  backup digest verified  ${backup.digest}`);
  if (discardChanges && receipt.target_digest && current !== receipt.target_digest) {
    console.log(`  discarded changes made after the migration, as asked`);
  }
}

function migrateBrand(flags: Flags): void {
  const root = resolveProject(required(flags, "project-root"));
  const rollback = flags["rollback"];
  const marker = readMigrationMarker(root);

  if (typeof rollback === "string" && rollback.length > 0) {
    rollbackBrandMigration(root, rollback, flags["discard-changes"] === true);
    return;
  }
  if (flags["resume"] === true) {
    if (!marker) throw new PlangonautError(`No migration is in flight here: there is no ${MIGRATION_MARKER}.`);
    resumeBrandMigration(root, marker);
    return;
  }
  if (marker) {
    throw new PlangonautError(
      `A migration is already in flight here: ${marker.migration_id}, stopped at phase "${marker.phase}".\n` +
        `Finish it or undo it:\n` +
        `  plangonaut migrate-brand --project-root . --resume\n` +
        `  plangonaut migrate-brand --project-root . --rollback ${marker.migration_id}`,
      "MIGRATION_INCOMPLETE",
    );
  }

  const migrationId = `MIG-${crypto.randomBytes(6).toString("hex")}`;
  const plan = planBrandMigration(root, migrationId);

  if (flags["dry-run"] === true) {
    printMigrationPlan(plan);
    return;
  }
  if (plan.blockers.length) {
    throw new PlangonautError(`This project cannot be migrated:\n- ${plan.blockers.join("\n- ")}\nNothing was written.`);
  }
  runBrandMigration(root, plan);
}

function printJsonError(argv: string[], error: any): void {
  const kind: ErrorKind = error instanceof PlangonautError ? error.kind : "COMMAND_FAILED";
  const payload: Record<string, unknown> = {
    ok: false,
    error: {
      kind,
      message: String(error?.message ?? error),
      command: argv[0] ?? null,
    },
  };
  if (kind === "PROJECT_STATE_UNTRUSTED") payload.blockers_assurance = "UNTRUSTED";
  console.log(JSON.stringify(payload, null, 2));
}

/**
 * A non-zero exit from a command that answered rather than refused.
 *
 * `handoff-check --json` reports `deliverable: false` as *data*: the JSON is the
 * answer, and a refusal document would replace it with something the caller did
 * not ask for. A pipeline still needs the exit code. Setting `process.exitCode`
 * from inside the command does not work — `bin/plangonaut.ts` assigns
 * `process.exitCode = await main(...)` afterwards and overwrites it — so the
 * code travels the same way every other outcome does: through `main`'s return.
 */
let reportedExitCode = 0;

export async function main(argv: string[]): Promise<number> {
  // The tests drive `main` in one process, one command after another. A
  // transaction left open by a command that threw would otherwise be adopted by
  // the next one and completed under its name.
  activeTransaction = null;
  pendingOperation = null;
  recoveredInThisRun = [];
  reportedExitCode = 0;
  runningCommand = argv[0] ?? "beave";
  try {
    const { command, flags } = parse(argv);
    CURRENT_COMMAND = command ?? "";
    // `--help` is answered before the options are checked, and before anything
    // is required. Someone reaching for it does not know the options yet — that
    // is what they are asking — so refusing them for an unknown one, or for a
    // missing `--project-root`, answers a question nobody asked.
    /*
     * `--help` works on every command.
     *
     * The general help promises it — "Any command takes --help" — and it was
     * true of seven. `task --help` was refused as an unknown option, which is
     * the worst of both: the documentation says to ask, and asking is an error.
     */
    if (flags.help === true && command && anyCommandHelp(command)) {
      console.log(anyCommandHelp(command));
      return 0;
    }
    assertKnownOptions(command, flags);
    if (!command || command === "help" || command === "--help" || command === "-h") help();
    // The product name travels with the number, because something has to read
    // this and decide whether the file it just found is *this* tool. Studio's
    // detection does exactly that — it runs `--version` on whatever is on the
    // PATH and only calls it verified when the answer names the product — and a
    // bare version string left every correct installation marked unverified.
    else if (command === "version" || command === "--version" || command === "-v")
      console.log(`plangonaut ${VERSION}`);
    else if (command === "capabilities") capabilities();
    else if (command === "init") init(flags);
    else if (command === "status") status(flags);
    else if (command === "next") next(flags);
    else if (command === "resume") resume(flags);
    else if (command === "replay") replay(flags);
    else if (command === "baseline") baseline(flags);
    else if (command === "recover") recover(flags);
    else if (command === "unlock") unlock(flags);
    else if (command === "qa-ask") qaAsk(flags);
    else if (command === "qa-answer") qaAnswer(flags);
    else if (command === "qa-settle") qaSettle(flags);
    else if (command === "qa-close") qaClose(flags);
    else if (command === "qa-supersede") qaSupersede(flags);
    else if (command === "qa-log") qaLog(flags);
    else if (command === "record") record(flags);
    else if (command === "blocker-record") blockerRecord(flags);
    else if (command === "blocker-resolve") blockerResolve(flags);
    else if (command === "blocker-verify-none") blockerVerifyNone(flags);
    else if (LEDGER_RULES[command]) ledgerMutation(command, flags);
    else if (command === "override") override(flags);
    else if (command === "re-record") reRecord(flags);
    else if (command === "reconcile") reconcile(flags);
    else if (command === "forecast") forecast(flags);
    else if (command === "gate") gate(flags);
    else if (command === "doc-diff") docDiff(flags);
    else if (command === "doc-mark-deletion") docMarkDeletion(flags);
    else if (command === "doc-save") docSave(flags);
    else if (command === "doc-history") docHistory(flags);
    else if (command === "doc-restore") docRestore(flags);
    else if (command === "doc-finalize") docFinalize(flags);
    else if (command === "context-pack") contextPack(flags);
    else if (command === "validate") {
      const root = resolveProject(required(flags, "project-root"));
      const state = validateRoot(root, true);
      // Reported here and nowhere else: see `recordedDigestErrors`.
      const drift = recordedDigestErrors(root, state);
      if (drift.length) throw new PlangonautError(`Validation failed:\n- ${drift.join("\n- ")}`, "PROJECT_STATE_UNTRUSTED");
      // The history is part of what "valid" means now. A project whose state does
      // not match its own events is not valid; one whose events predate the replay
      // format is, and is told what it cannot prove rather than refused.
      const history = historyErrors(root, state);
      if (history.errors.length) throw new PlangonautError(`Validation failed:\n- ${history.errors.join("\n- ")}`, "PROJECT_STATE_UNTRUSTED");
      // Documents the project looks like it should be governing.
      //
      // A warning by default and an error under `--strict`, and that order round
      // is deliberate. An anomaly that only speaks behind a flag is invisible to
      // exactly the person who does not know the flag exists — which is everyone
      // meeting this for the first time, including the agent in the pilot. So
      // `validate` always says it, and `--strict` is for the caller who has
      // decided the project may not carry one: a release check, a handoff, a
      // pipeline.
      const unclaimed = unclaimedDocumentReport(root, state);
      /*
       * Where the prose and the typed ledger disagree. Reported always, never
       * refused at the write: see `ledgerCoherenceFindings` for why the
       * direction is that way round. Under `--strict` it fails, and it has to:
       * the warning an approval prints says "--strict fails on it", and the
       * synthetic pilot caught the engine not keeping that promise. A promise
       * the tool does not keep is the same defect this cycle is about, made by
       * the engine instead of by an agent.
       */
      const coherence = ledgerCoherenceFindings(root, state);
      /*
       * `--strict` is the flag a release check and a handoff use, and both of
       * them are asking whether the folder is fit to leave. A project that is
       * to be built and has no plan for building it is not, so it fails here
       * too — and only when execution was actually requested, because a
       * feasibility study passing `--strict` is correct.
       */
      const strictReadiness = readinessReport(state, root);
      const strictExecution = strictReadiness.intent === "YES" && strictReadiness.execution.verdict === "FAILED"
        ? strictReadiness.execution.findings
        : [];
      if (flags.strict === true && (unclaimed.findings.length || coherence.length || strictExecution.length)) {
        const parts: string[] = [];
        if (unclaimed.findings.length) parts.push(`- ${unclaimed.findings.join("\n- ")}\n\n${unclaimed.remedy.join("\n")}`);
        if (coherence.length) parts.push(`- ${coherence.join("\n- ")}`);
        if (strictExecution.length) parts.push(`execution readiness failed:\n- ${strictExecution.join("\n- ")}`);
        throw new PlangonautError(
          `Validation failed (--strict):\n${parts.join("\n\n")}`,
          "PROJECT_STATE_UNTRUSTED"
        );
      }
      console.log("Plangonaut state is valid.");

      /*
       * Valid is a statement about integrity, and says nothing about whether
       * the project can be executed. Both are printed, because the pilot's
       * folder was valid on every run it ever had.
       */
      const readiness = readinessReport(state, root);
      console.log(`\n${readinessLines(readiness, "NOT ASSESSED").slice(0, 2).join("\n")}`);
      if (readiness.execution.verdict === "FAILED") {
        console.log(`\nExecution readiness fails on ${readiness.execution.findings.length} thing${readiness.execution.findings.length === 1 ? "" : "s"}:`);
        for (const line of readiness.execution.findings) console.log(`- ${line}`);
        console.log(`\nIntegrity is what "valid" means above. This is whether anybody could pick the folder up and build it. --strict makes it an error.`);
      } else if (readiness.execution.verdict === "NOT ASSESSED") {
        console.log(`\n${readiness.execution.findings.join("\n")}`);
        for (const line of readiness.execution.remedy) console.log(line);
      }
      if (unclaimed.findings.length) {
        console.log(`\nWARNING: ${unclaimed.findings.length === 1 ? "one document is" : `${unclaimed.findings.length} documents are`} outside the ledger.`);
        for (const line of unclaimed.findings) console.log(`- ${line}`);
        console.log(`\n${unclaimed.remedy.join("\n")}`);
        console.log(`\nThe state above is valid; these files are not part of it. --strict makes this an error.`);
      }
      if (coherence.length) {
        console.log(`\nWARNING: ${coherence.length} statement${coherence.length === 1 ? "" : "s"} in this project ${coherence.length === 1 ? "does" : "do"} not match the ledger.`);
        for (const line of coherence) console.log(`- ${line}`);
        console.log(`\nMechanical integrity is what "valid" means above; this is about whether the records say the same thing as the documents. --strict makes this an error.`);
      }

      // Reported, never acted on. See `legacyBackupDirectories`.
      const legacy = legacyBackupDirectories(root);
      if (legacy.length) {
        const total = legacy.reduce((sum, entry) => sum + entry.files, 0);
        console.log(`\nNOTE: ${total} backup file${total === 1 ? " sits" : "s sit"} outside ${STATE_DIR}/, in ${legacy.map((entry) => `${entry.relative}/`).join(", ")}.`);
        console.log(`This engine writes them under ${STATE_DIR}/${DOCUMENT_BACKUPS}/ instead. The existing ones are left exactly where they are — they are backups, and some may hold the only copy of a revision.`);
        console.log(`To move them, verified by digest and with a receipt: plangonaut migrate-backups --project-root . --apply`);
        console.log(`To see what that would do first, run it without --apply.`);
      }
      // Said out loud, because the alternative is the defect B5 was: a project
      // reporting "valid" over gates whose evidence nothing had looked at since.
      const gapNote = unverifiableGateNote(state);
      if (gapNote) console.log(`\n${gapNote}`);
      for (const note of history.notes) console.log(`\n${note}`);
    }
    else if (command === "migrate") migrate(flags);
    else if (command === "migrate-backups") migrateBackups(flags);
    // Reading is the bare name, because reading is the safe thing to reach for.
    else if (command === "doc-lock") docLockStatus(flags);
    else if (command === "doc-lock-acquire") docLockAcquire(flags);
    else if (command === "doc-lock-release") docLockRelease(flags);
    else if (command === "doc-lock-recover") docLockRecover(flags);
    else if (command === "doc-lock-force-release") docLockForceRelease(flags);
    else if (command === "handoff-check") handoffCheck(flags);
    else if (command === "execution-readiness") executionReadinessCommand(flags);
    else if (command === "compat-check") compatCheck(flags);
    else if (command === "execution-intent") executionIntent(flags);
    else if (command === "execution-org") executionOrg(flags);
    else if (command === "read-record") readRecord(flags);
    else if (command === "govern") govern(flags);
    else if (command === "migrate-brand") migrateBrand(flags);
    else if (command === "project-export") projectExport(flags);
    else if (command === "project-verify") projectVerify(flags);
    else if (command === "project-import") projectImport(flags);
    else if (command === "export") exportTarget(flags);
    else if (command === "install") install(flags);
    else if (command === "verify-install") verifyInstall(flags);
    else throw new PlangonautError(unknownCommandMessage(command));
    return reportedExitCode;
  } catch (error: any) {
    /*
     * Two channels, never both.
     *
     * A human gets the sentence on stderr, as always. A caller that asked for
     * JSON gets a document on stdout and nothing on stderr, because a caller
     * that redirects `2>&1` would otherwise be handed a prefix that is not JSON
     * — which is exactly the failure this is meant to remove.
     *
     * The exit code is unchanged at 2. `kind` is the new information; renumbering
     * the exits would break every caller that already handles the old ones for
     * the sake of a distinction this field already carries.
     */
    if (jsonChannel(argv)) printJsonError(argv, error);
    else console.error(`PLANGONAUT ERROR: ${error.message}`);
    return 2;
  } finally {
    // The lock is released on the way out however the command ended, and again
    // from the `exit` handler if something skipped this. A kill skips both,
    // which is exactly what the stale-lock rules above are for.
    releaseProjectLock();
  }
}
