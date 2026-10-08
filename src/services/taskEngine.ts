import { AutonomousForager, PreemptedError, type PreemptionProbe } from "./autonomousForager";
import { clearCurrentProcess, setCurrentProcess } from "./heartbeat";
import type { ResourceGovernor } from "./resourceGovernor";
import type { SwarmClient, SwarmTask } from "../network/SwarmClient";

/**
 * THE DUAL-TIER TASK ENGINE.
 *
 * THE PROBLEM IT SOLVES. The node used to be strictly passive: it asked the
 * Mothership for work, and if the answer was "none" it sat there. A fleet of
 * passive nodes is a fleet that only knows what the cloud already knows, and
 * every scraper, every parser and every GPU sitting idle in the meantime is
 * capacity thrown away. So the node now runs two tiers at once:
 *
 *     PRIORITY (Mothership) — assigned work. Always wins. Always first.
 *     IDLE      (Autonomous) — foraging the local database when nothing has
 *                              been assigned, fed upstream as it learns.
 *
 * THE CONTRACT BETWEEN THEM. One flag, `isProcessingPriority`, plus a pair of
 * gates. The forager never decides whether it may yield — it asks, at every
 * stage boundary, and stops. The engine never decides what foraging means — it
 * hands the forager a probe and gets out of the way. Neither can starve the
 * other, and neither can deadlock the other, because the only direction work
 * moves is "downward in priority", which is exactly the direction a yield
 * resolves.
 *
 * WHY TWO LOOPS RATHER THAN ONE LOOP WITH AN IF. Preemption only works if the
 * Mothership is polled WHILE the forager is mid-pass. A single loop that polls
 * first and then forages cannot notice an interrupt arriving during a 30-second
 * page load, because it is not looking. These two run concurrently and meet in
 * the middle: the priority loop owns the flag, the idle loop owns the cursor.
 *
 * RESUME IS EXACT. The forager's session object outlives the yield, so a pass
 * interrupted at `extract` resumes at `persist` with its evidence already
 * scraped. Nothing is re-fetched and nothing is re-learned.
 */

/** How often the priority tier asks the Mothership for work. */
const PRIORITY_POLL_MS = 15_000;
/**
 * THERMAL GOVERNOR — the cooling gap between forage passes.
 *
 * A node left foraging 24/7 would otherwise pin CPU/GPU forever and melt its
 * host. This fixed sleep between passes lets cooling recover; production
 * honours `IDLE_THROTTLE` / `IDLE_THROTTLE_MS` / `IDLE_THROTTLE_SECONDS`
 * (seconds or milliseconds, clamped to 10–30s — see `resolveIdleThrottleMs`),
 * so operators can tune the duty cycle without rebuilding. No env set means
 * the 20s midpoint: cool enough for a laptop lid closed overnight, busy
 * enough that the fleet still learns.
 */
const IDLE_PASS_GAP_MS = 60_000;
/** Floor of the thermal clamp — below this the cooler never recovers. */
const IDLE_THROTTLE_MIN_MS = 10_000;
/** Ceiling of the thermal clamp — above this the node barely forages. */
const IDLE_THROTTLE_MAX_MS = 30_000;
/**
 * Default when no env override is set — the midpoint of the clamp.
 *
 * Read by the status panels (and the engine's start line) so the operator can
 * see the pacing without opening the source. The engine itself falls back to
 * its legacy constant when `resolveIdleThrottleMs()` returns undefined, which
 * keeps the constructor's explicit-override-wins shape intact.
 */
export const IDLE_THROTTLE_DEFAULT_MS = 20_000;

/** The two tiers. */
export type TaskTier = "priority" | "idle";

/** How a priority task ended. */
export type TaskStatus = "success" | "failure" | "skipped";

/**
 * SELF-HEALING CAP — consecutive failures before a task is requeued (epic §3).
 *
 * A task that keeps failing on THIS node (bad payload for this hardware, a
 * model that cannot parse it) must be pushed back to the Mothership as an
 * error state so it is cleanly requeued to ANOTHER machine — never retried
 * here forever. Per task id; success resets the count. Exported for tests.
 */
export const MAX_CONSECUTIVE_TASK_FAILURES = 3;

/**
 * What a priority handler reports back.
 *
 * `reported` exists because some handlers already report their own detailed
 * results (a healed skill posts its patched source, for instance). The engine
 * only files a generic `task_result` when the handler did NOT, so the
 * Mothership never receives two contradictory records for one task.
 */
export interface TaskOutcome {
  status: TaskStatus;
  /** Human-readable detail, safe to send upstream. */
  detail: string;
  /** True when the handler has already filed its own result. */
  reported?: boolean;
}

/** Executes one Mothership-assigned task. */
export type PriorityTaskHandler = (task: SwarmTask) => Promise<TaskOutcome>;

/** Wiring the engine needs from its host. */
export interface TaskEngineDeps {
  swarm: SwarmClient;
  /** Executes a priority task to completion. Must never throw. */
  handlePriorityTask: PriorityTaskHandler;
  forager: AutonomousForager;
  /**
   * RESOURCE GOVERNOR — caps how many priority tasks may run at once.
   *
   * Optional so the engine stays constructible without one (the verification
   * harness builds it standalone). When absent the engine runs one task at a
   * time, exactly as it did before the Governor existed.
   */
  governor?: ResourceGovernor;
  /** Overridable for tests; defaults to the 15s Mothership poll. */
  priorityPollMs?: number;
  /**
   * THERMAL PACING — the cooling gap between forage passes.
   *
   * Overridable for tests; production reads `IDLE_THROTTLE` from the
   * environment (see `resolveIdleThrottleMs`), clamped to 10–30s. The gap lets
   * the host's cooling recover between GPU/CPU-heavy passes so a node left
   * foraging 24/7 never melts its host.
   */
  idleGapMs?: number;
}

/** A promise plus the means to resolve it from outside. */
interface Gate {
  promise: Promise<void>;
  open: () => void;
}

function createGate(): Gate {
  let open = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

export class TaskEngine {
  private running = false;
  private priorityLoop: Promise<void> | null = null;
  private idleLoop: Promise<void> | null = null;

  /** Assigned work waiting to run, or being run. */
  private readonly queue: SwarmTask[] = [];
  /** True from the instant work arrives until the queue has fully drained. */
  private isProcessingPriority = false;
  /** Set while the queue is non-empty, so a second drain cannot overlap. */
  private draining = false;
  /** Guards against two polls in flight when a heartbeat also pushes work. */
  private polling = false;
  /**
   * THE INTERRUPT — the AbortController behind idle preemption.
   *
   * Owned by the engine, armed per forage pass, fired by `dispatch()` the
   * instant a PRIORITY task arrives. The forager's probe carries its signal
   * into the in-flight Playwright navigation and the Ollama HTTP body, so the
   * background scrape/inference dies MID-flight — the deck is cleared for the
   * user task instead of finishing background work nobody needs any more. A
   * fresh controller is armed for every pass (see `armIdleAbort`), because an
   * AbortSignal is single-shot: once fired it stays fired, and reusing it
   * would abort every future pass on sight.
   */
  private idleAbort: AbortController | null = null;
  /**
   * Priority tasks executing right now. Bounded by the Resource Governor's
   * `max_concurrent_tasks`; this is the number {@link atCapacity} compares
   * against, and what makes "delay pulling new work" observable from outside.
   */
  private inFlight = 0;
  /**
   * Waiters parked on "a priority task just arrived". Open by {@link dispatch}.
   *
   * A LIST, NOT A SINGLE GATE, and that is the fix for a subtle deadlock: the
   * forager asks to be told about an interrupt *before* the interrupt exists,
   * because it is already inside a scrape when the task arrives. A single
   * pre-created gate handles that; a gate created on demand does not, and the
   * forager would sit out the whole navigation it was supposed to abandon.
   */
  private readonly interruptWaiters: Array<() => void> = [];
  /** Waiters parked on "the Mothership is finished with this node". */
  private readonly resumeWaiters: Array<() => void> = [];
  /** Resolved by {@link stop} so nothing parks forever on shutdown. */
  private shutdown = createGate();

  private readonly priorityPollMs: number;
  private readonly idleGapMs: number;
  /** Ensures a permanently-unavailable brain is reported once, not every pass. */
  private skippedLogged = false;
  /**
   * Consecutive failure counts per task id — the requeue guard (epic §3).
   * Success (or a skip) clears the entry; the third straight failure releases
   * the task back to the Mothership instead of claiming it again.
   */
  private readonly consecutiveFailures = new Map<string, number>();

  constructor(private readonly deps: TaskEngineDeps) {
    this.priorityPollMs = deps.priorityPollMs ?? PRIORITY_POLL_MS;
    // Explicit test override wins; otherwise the operator's IDLE_THROTTLE env
    // (10–30s clamp); otherwise the legacy 60s constant. The harness passes
    // hours so its parked sleeps never fire mid-assertion.
    this.idleGapMs = deps.idleGapMs ?? resolveIdleThrottleMs() ?? IDLE_PASS_GAP_MS;
  }

  /**
   * HOW MANY PRIORITY TASKS MAY RUN AT ONCE — the Resource Governor's ceiling,
   * floored at 1 so a misconfigured zero cannot wedge the queue forever.
   *
   * Without a Governor this returns 1, which restores the pre-Governor
   * behaviour exactly: a strictly serial priority tier.
   */
  private concurrencyLimit(): number {
    const max = this.deps.governor?.getCurrentLimits().max_concurrent_tasks ?? 1;
    return Math.max(1, Math.floor(max));
  }

  /** True when the node is already running as much as it is allowed to. */
  private atCapacity(): boolean {
    return this.inFlight >= this.concurrencyLimit();
  }

  /** Priority tasks in flight right now — surfaced for telemetry/tests. */
  inFlightCount(): number {
    return this.inFlight;
  }

  /** The live tier, for the heartbeat and the Control Center. */
  currentTier(): TaskTier {
    return this.isProcessingPriority ? "priority" : "idle";
  }

  /** True while the Mothership has this node. */
  isProcessingPriorityTier(): boolean {
    return this.isProcessingPriority;
  }

  /**
   * PRIORITY vs IDLE_FORAGE at a glance — for the status panels.
   *
   * `tier` is the live tier; `idleThrottleMs` is the thermal pacing between
   * forage passes (the operator's IDLE_THROTTLE, clamped 10–30s). Surfaced so
   * an operator can see "foraging every 20s, priority preempts instantly"
   * without opening the source.
   */
  describeTiers(): { tier: TaskTier; idleThrottleMs: number; priorityPollMs: number } {
    return {
      tier: this.currentTier(),
      idleThrottleMs: this.idleGapMs,
      priorityPollMs: this.priorityPollMs,
    };
  }

  /**
   * Starts both tiers. Idempotent, and never blocks the caller.
   *
   * The priority loop polls once immediately so a node that boots into a
   * backlog does not spend fifteen seconds looking at an empty local database
   * first — the idle tier has no idea work is already waiting for it.
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.shutdown = createGate();

    // Work pushed down the heartbeat reaches the same queue as polled work, so
    // there is exactly one code path from "the Mothership said go" to "the node
    // is doing it" — and therefore exactly one place preemption can be missed.
    this.deps.swarm.setTaskDispatchHandler((tasks) => this.dispatch(tasks));

    this.priorityLoop = this.runPriorityLoop();
    this.idleLoop = this.runIdleLoop();

    console.log(
      `[Swarm] Task engine started — PRIORITY tier polls every ` +
        `${this.priorityPollMs / 1000}s, IDLE_FORAGE tier forages every ${this.idleGapMs / 1000}s ` +
        `(IDLE_THROTTLE thermal pacing; a priority task aborts the in-flight pass at once).`,
    );
  }

  /** Stops both tiers, letting the in-flight work settle. */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.shutdown.open();
    // Interrupt waiters are opened too: a forager parked inside `acquire`'s
    // race would otherwise hold `stop()` hostage until its page load timed out.
    this.openAll(this.interruptWaiters);
    this.releaseForager();
    this.deps.swarm.setTaskDispatchHandler(null);

    await Promise.all([this.priorityLoop, this.idleLoop].filter(Boolean) as Promise<void>[]);
    this.priorityLoop = null;
    this.idleLoop = null;
    console.log("[Swarm] Task engine stopped.");
  }

  isRunning(): boolean {
    return this.running;
  }

  /**
   * THE MOMENT OF PREEMPTION.
   *
   * Reached two ways — the 15-second poll, or a task pushed down the heartbeat —
   * and deliberately identical from here on. The flag goes up first, then the
   * waiters are woken: a forager parked on `waitForResume` must wake up and see
   * a node it is no longer allowed to work for, not a stale `false`.
   *
   * Duplicates are dropped by task id. A Mothership that has not yet retired a
   * completed task will hand it back on the very next poll, and re-running it
   * would be worse than doing nothing.
   */
  dispatch(tasks: SwarmTask[]): void {
    const fresh = tasks.filter((task) => !this.queue.some((queued) => queued.id === task.id));
    if (fresh.length === 0) return;

    const wasIdle = !this.isProcessingPriority;
    this.queue.push(...fresh);
    this.isProcessingPriority = true;

    console.log(
      `[Swarm] INTERRUPT: Mothership priority task received! ` +
        `${fresh.length} task(s) queued${wasIdle ? ` — pausing idle foraging.` : `.`}`,
    );

    // THE INTERRUPT: fire the AbortController FIRST, so the in-flight
    // Playwright navigation and Ollama HTTP body die immediately — the deck is
    // cleared for the PRIORITY task instead of finishing a background scrape
    // nobody needs any more. The gate wake below is the second tripwire for
    // foragers parked between stages.
    this.abortIdlePass("priority task arrived");
    // Woken before anything else: a forager already inside a page load must
    // stop waiting on it immediately, not at the next stage boundary.
    this.openAll(this.interruptWaiters);

    // Drain straight away. Waiting for the next poll tick would add up to
    // fifteen seconds of the node standing still holding work it was told to do.
    void this.drain();
  }

  /**
   * THE PRIORITY TIER — ask the Mothership for work, every 15 seconds.
   *
   * Runs concurrently with the idle tier and deliberately does NOT care whether
   * the forager is mid-pass: noticing an interrupt while a 30-second page load
   * is in flight is the entire reason this is a separate loop.
   */
  private async runPriorityLoop(): Promise<void> {
    while (this.running) {
      // Polled BEFORE the sleep, so a node that boots into a backlog starts work
      // immediately instead of spending fifteen seconds letting the idle tier
      // scrape a page it was never meant to be scraping.
      //
      // THE CAPACITY GATE IS THE GOVERNOR'S "delay pulling new work": while a
      // priority task is queued or running the tier is already saturated, and
      // asking the Mothership for more work this node cannot yet run is how a
      // local machine ends up monopolised. `!isProcessingPriority` already
      // covers this in practice; `!atCapacity()` makes the rule explicit and
      // keeps it correct if the two ever diverge.
      if (!this.polling && !this.isProcessingPriority && !this.atCapacity()) {
        this.polling = true;
        try {
          this.dispatch(await this.deps.swarm.fetchTasks());
        } catch (error) {
          // fetchTasks already reports its own failures; this only catches the
          // genuinely unexpected so the loop itself cannot die.
          console.warn(
            `[Swarm] Priority poll failed — ${error instanceof Error ? error.message : String(error)}`,
          );
        } finally {
          this.polling = false;
        }
      }
      await Promise.race([sleep(this.priorityPollMs), this.shutdown.promise]);
    }
  }

  /**
   * THE IDLE TIER — forage the Mothership queue, then the local database.
   *
   * Each pass arms a FRESH AbortController (a fired signal stays fired, so
   * reuse would abort the next pass on sight). When idle the node asks the
   * Mothership for a `forage_target` first and falls back to its local queue;
   * either way the pass scrapes, extracts, persists and feeds.
   *
   * THERMAL PACING: after a completed pass the loop sleeps `idleGapMs`
   * (IDLE_THROTTLE, 10–30s clamp) so the host's cooling recovers — a node
   * foraging 24/7 must never melt its host. A preempted pass skips the sleep
   * (see below) and a new idle task is only requested once the priority queue
   * is at zero (see `waitForIdleWindow`).
   *
   * The order of the two waits at the top of every iteration is the whole
   * design. Yielding comes FIRST, so the loop parks on the resume gate before
   * it does anything expensive, and the gap sleep comes second, so an idle node
   * spends its time waiting rather than holding the CPU.
   */
  private async runIdleLoop(): Promise<void> {
    while (this.running) {
      // 1. Park until the Mothership is finished with this node.
      await this.waitForIdleWindow();
      if (!this.running) break;

      // 2. Arm a fresh interrupt for this pass, then run it. The probe inside
      //    carries the signal into the scrape + inference, so a PRIORITY task
      //    arriving mid-pass aborts the in-flight I/O at once.
      this.armIdleAbort();
      let preempted = false;
      /*
        Status telemetry. The node is genuinely busy — a Playwright page load and
        a local-model call are not idle — and leaving the heartbeat saying "idle"
        would have the Mothership route a priority task to a node that is already
        mid-scrape, on the grounds that it "looked free".
      */
      if (!this.isProcessingPriority) {
        this.deps.swarm.setStatus("busy");
        setCurrentProcess("forage:local-database");
      }
      try {
        const outcome = await this.deps.forager.runPass(this.probe());
        preempted = outcome.status === "preempted";
        this.reportIdleOutcome(outcome.status, outcome.message);
      } catch (error) {
        if (error instanceof PreemptedError) {
          preempted = true;
          continue;
        }
        console.warn(
          `[Swarm] Idle forage pass failed — ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        // The pass is over — disarm the controller so a LATE abort cannot leak
        // into the next pass (a fired signal stays fired; see `armIdleAbort`).
        this.idleAbort = null;
        /*
          Cleared ONLY while the idle tier still owns the node. If a Mothership
          task arrived mid-pass, the priority tier has already claimed this
          telemetry and overwriting it here would report the node as free at the
          exact moment it is running assigned work.
        */
        if (!this.isProcessingPriority) {
          this.deps.swarm.setStatus("idle");
          clearCurrentProcess();
        }
      }

      /*
        A preempted pass skips the gap entirely. The throttle exists to keep a
        node from hammering its sources, and a node that was just interrupted
        has not hammered anything — sleeping here would strand the forager's
        saved cursor for a full minute after the Mothership released it, which
        is the difference between "instantly resumes" and "resumes eventually".
      */
      if (preempted) continue;

      // 3. THERMAL GOVERNOR. Cool the host between passes: one completed pass
      //    then `idleGapMs` of sleep (IDLE_THROTTLE, 10–30s), so a node
      //    foraging 24/7 never melts its host. The sleep is interruptible —
      //    a PRIORITY task arriving mid-cooldown wakes the loop at once via
      //    the resume-gate race below, so pacing never delays user work.
      await Promise.race([
        sleep(this.idleGapMs),
        this.shutdown.promise,
        this.park("interrupt"),
      ]);
    }
  }

  /**
   * Blocks the idle tier for as long as the priority tier owns the node.
   *
   * Raced against `shutdown` so a stop during a long priority task cannot leave
   * this loop parked on a gate that will never be opened.
   */
  private async waitForIdleWindow(): Promise<void> {
    while (this.running && this.isProcessingPriority) {
      console.log("[Swarm] Idle tier parked — priority work in progress.");
      await Promise.race([this.park("resume"), this.shutdown.promise]);
    }
  }

  /**
   * THE PROBE HANDED TO THE FORAGER — the engine's entire vocabulary to the
   * idle tier. It exposes state and gates; it never reaches into the forager.
   *
   * `signal` is the live AbortController signal for the CURRENT pass: the
   * in-flight Playwright navigation and Ollama HTTP body race it, so a
   * PRIORITY task arriving mid-scrape or mid-inference clears the deck at
   * once instead of waiting for the next stage boundary. The stage
   * checkpoints (`shouldYield` / `waitForInterrupt`) remain as the second
   * tripwire for aborts that land between stages.
   *
   * Both waits resolve IMMEDIATELY when the condition they are waiting for is
   * already true. That asymmetry is what makes them safe to call from inside a
   * race: a forager that starts a stage during a preemption gets stopped at
   * once, and one that starts a stage just after the queue drained is not
   * parked at all.
   */
  private probe(): PreemptionProbe {
    return {
      shouldYield: () => this.isProcessingPriority,
      waitForInterrupt: () => this.park("interrupt"),
      waitForResume: () => this.park("resume"),
      signal: this.idleAbort?.signal,
    };
  }

  /** Parks the caller until the named event, or returns at once if it has passed. */
  private park(kind: "interrupt" | "resume"): Promise<void> {
    if (kind === "interrupt") {
      if (this.isProcessingPriority) return Promise.resolve();
      return new Promise<void>((resolve) => this.interruptWaiters.push(resolve));
    }
    if (!this.isProcessingPriority) return Promise.resolve();
    return new Promise<void>((resolve) => this.resumeWaiters.push(resolve));
  }

  /**
   * ARMS A FRESH INTERRUPT FOR THE NEXT FORAGE PASS.
   *
   * Called at the top of every idle pass. A new controller every time because
   * an AbortSignal is single-shot — once fired it stays fired, and reusing
   * the previous pass's controller would abort the new pass on sight before
   * it scraped a single byte.
   */
  private armIdleAbort(): void {
    this.idleAbort = new AbortController();
  }

  /**
   * FIRES THE IDLE INTERRUPT — the deck-clearing half of preemption.
   *
   * Called by `dispatch()` the instant a PRIORITY task arrives. Aborting the
   * controller cancels the in-flight Playwright navigation and the Ollama HTTP
   * body inside the forager; the pass then throws `PreemptedError`, keeps its
   * session cursor, and parks until the priority queue drains to zero. Safe to
   * call with no pass running (a cooldown sleep, a parked loop): aborting with
   * no listener just wakes the gate race, which is exactly what "a priority
   * task arrived during the thermal sleep" must do.
   */
  private abortIdlePass(reason: string): void {
    const controller = this.idleAbort;
    if (!controller || controller.signal.aborted) return;
    try {
      controller.abort(new PreemptedError(reason));
    } catch {
      // Aborting must never break dispatch: the priority task is already
      // queued and the gate wake below still yields the forager.
    }
  }

  /** Opens every waiter on a list, leaving the list empty. */
  private openAll(waiters: Array<() => void>): void {
    while (waiters.length > 0) waiters.pop()?.();
  }

  /** One line per pass, at a volume that does not bury the interesting news. */
  private reportIdleOutcome(status: string, message: string): void {
    if (status === "learned") {
      console.log(`[Swarm] Foraged ${message}`);
      return;
    }
    // Preemption is already announced by the forager and the dispatch handler;
    // repeating it here would double every interrupt in the log.
    if (status === "preempted") return;
    // A satellite has no brain and will say so on every pass forever; the
    // operator needs to be told once, not once a minute for a week.
    if (status === "skipped") {
      if (!this.skippedLogged) {
        this.skippedLogged = true;
        console.log(`[Swarm] Idle tier standing down — ${message}`);
      }
      return;
    }
    console.log(`[Swarm] Idle: Foraging local database... ${message}`);
  }

  /**
   * EXECUTES THE PRIORITY QUEUE TO COMPLETION.
   *
   * The re-check of `this.queue.length` inside the loop is the detail that
   * makes this correct rather than merely plausible: if the heartbeat pushes
   * more work while the last task is finishing, the flag is NOT lowered, the
   * gates are NOT opened, and this same drain picks the new work straight up.
   * Lowering them first would hand the node back to the forager for a full 60
   * seconds while assigned work sat in the queue.
   */
  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;

    try {
      /*
        CONCURRENCY (RESOURCE GOVERNOR). This used to be a single loop that ran
        one task at a time. The Governor now decides how many may run in
        parallel — Low: 1, Medium: 2, High: one per core — so the drain spawns
        that many workers, each pulling from the SAME queue until it is empty.

        Preemption is untouched. `isProcessingPriority` stays raised for as long
        as ANY worker is running or any task is still queued (it is only cleared
        in the `finally` below, once the queue is empty), so the idle forager
        yields for the whole busy window exactly as before.
      */
      const workers: Promise<void>[] = [];
      const count = this.concurrencyLimit();
      for (let i = 0; i < count; i += 1) {
        workers.push(this.runWorker());
      }
      await Promise.all(workers);
    } finally {
      this.draining = false;
      if (this.queue.length === 0 && this.isProcessingPriority) {
        this.isProcessingPriority = false;
        /*
          ORDER MATTERS HERE. The telemetry is released BEFORE the forager is
          woken, never after: the forager's first act on waking is to claim
          "busy" for its next pass, so clearing it afterwards would overwrite
          that claim and report the node as free while it is already working.
        */
        this.deps.swarm.setStatus("idle");
        clearCurrentProcess();
        this.releaseForager();
        this.reportResume();
      } else if (this.queue.length > 0 && this.running) {
        /*
          WORK ARRIVED IN THE MICROTASK WINDOW. With one loop this could not
          happen — the loop re-checked the queue synchronously. With workers the
          queue is emptied, the worker returns, and `Promise.all` resolves a
          microtask later; a `dispatch` landing in that gap would be swallowed
          because `draining` is still true. Re-draining picks that task up
          instead of stranding it until the next poll.
        */
        void this.drain();
      }
    }
  }

  /**
   * One drain worker: pulls tasks from the shared queue until it is empty.
   *
   * The `inFlight` counter is what the Governor's limit is measured against,
   * and what {@link atCapacity} reads to decide whether new work may be pulled.
   */
  private async runWorker(): Promise<void> {
    while (this.running) {
      const task = this.queue.shift();
      if (!task) return;
      this.inFlight += 1;
      try {
        await this.runPriorityTask(task);
      } finally {
        this.inFlight -= 1;
      }
    }
  }

  /**
   * Runs one assigned task and reports the result.
   *
   * THE ORDER HERE IS THE FIX FOR "THE NODES IGNORE THE QUEUE". The claim comes
   * FIRST and the execution second: the node announces that it has taken
   * ownership (and the heartbeat starts reporting `status: "working"`) before it
   * starts work, so the Mothership can see the transition from available to
   * claimed instead of only learning about the task once it is already finished.
   *
   * A handler that throws is caught here rather than allowed to escape, because
   * a single bad task must not abandon the rest of the queue — and because the
   * `finally` in {@link drain} is what guarantees the node is released even when
   * it does.
   */
  private async runPriorityTask(task: SwarmTask): Promise<void> {
    /*
      CLAIM BEFORE EXECUTING. `claimTask` also flips the node to "working", so
      the status is honest from the moment the task is owned. It fails open by
      design (see SwarmClient.claimTask) — an unreachable claim route must never
      stop real work from being done.
    */
    await this.deps.swarm.claimTask(task);
    this.deps.swarm.setStatus("working");
    setCurrentProcess(task.type || task.id || "task");
    const startedAt = Date.now();

    let outcome: TaskOutcome;
    try {
      outcome = await this.deps.handlePriorityTask(task);
    } catch (error) {
      outcome = {
        status: "failure",
        detail: error instanceof Error ? error.message : String(error),
      };
    }

    const durationMs = Date.now() - startedAt;
    // Report success OR failure — a task that is never acknowledged stays in the
    // Mothership's queue forever, and a node that silently drops work looks
    // identical to a node that is ignoring it.
    if (!outcome.reported) {
      await this.deps.swarm.submitProfile({
        kind: "task_result",
        taskId: task.id,
        type: task.type,
        status: outcome.status,
        detail: outcome.detail,
        durationMs,
      });
    }

    // FATAL ERROR RECOVERY (epic §3): a task that consistently fails on THIS
    // node is pushed back as an error state so the Mothership cleanly requeues
    // it to another machine — never an infinite local retry loop. Success (or
    // a skip — the task asked for nothing this node should retry) resets the
    // count; the cap trips on the Nth straight failure.
    if (outcome.status === "failure") {
      const failures = (this.consecutiveFailures.get(task.id) ?? 0) + 1;
      this.consecutiveFailures.set(task.id, failures);
      if (failures >= MAX_CONSECUTIVE_TASK_FAILURES) {
        this.consecutiveFailures.delete(task.id);
        const reason =
          `task failed ${failures} consecutive times on this node` +
          (outcome.detail ? `: ${outcome.detail.slice(0, 300)}` : "") +
          " — requeue to another machine";
        console.warn(`[Swarm] Priority task ${task.id} hit the failure cap — releasing: ${reason}`);
        try {
          await this.deps.swarm.releaseTask(task, reason);
        } catch {
          // Best-effort: the error-state push above already told the
          // Mothership this attempt failed, so its own timeout requeues anyway.
        }
      }
    } else {
      this.consecutiveFailures.delete(task.id);
    }

    console.log(
      `[Swarm] Priority task ${task.id} (${task.type}) ${outcome.status} in ${durationMs}ms` +
        (outcome.detail ? ` — ${outcome.detail}` : "."),
    );
  }

  /**
   * HANDS THE NODE BACK TO THE IDLE TIER.
   *
   * The flag drops BEFORE the gate opens, for the same reason it was raised
   * before the gates armed: a forager waking from `waitForResume` reads
   * `shouldYield()` and must not see a node it is still forbidden to work for.
   */
  private releaseForager(): void {
    this.isProcessingPriority = false;
    this.openAll(this.resumeWaiters);
  }

  /** The log line that tells an operator the context switch has reversed. */
  private reportResume(): void {
    const stats = this.deps.forager.stats();
    console.log(
      `[Swarm] Resuming idle foraging. ` +
        `${stats.learned} discovery/discoveries learned, ${stats.fed} fed upstream, ` +
        `${stats.preemptions} preempted so far.`,
    );
  }
}

/** Waits `ms`, without keeping the process alive on its own. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * THERMAL GOVERNOR — resolves the cooling gap between forage passes.
 *
 * Reads `IDLE_THROTTLE` (aliases `IDLE_THROTTLE_MS`, `IDLE_THROTTLE_SECONDS`),
 * accepting either seconds or milliseconds: values ≤ 1000 are read as seconds
 * (an operator writing "20" means twenty seconds, not twenty milliseconds),
 * anything larger as milliseconds. The result is clamped to 10–30s — below
 * 10s the host's cooling never recovers, above 30s the node barely forages.
 *
 * Returns `undefined` when no override is set, so the caller falls back to
 * its default. Exported for the verification harness and the status panels.
 */
export function resolveIdleThrottleMs(
  envSource: NodeJS.ProcessEnv = process.env,
): number | undefined {
  const raw =
    envSource["IDLE_THROTTLE"] ?? envSource["IDLE_THROTTLE_MS"] ?? envSource["IDLE_THROTTLE_SECONDS"];
  if (raw === undefined || raw === null) return undefined;
  const text = String(raw).trim();
  if (!text) return undefined;
  const parsed = Number(text);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  // `IDLE_THROTTLE_SECONDS` is always seconds; the bare/MS names accept both.
  const explicitSeconds = envSource["IDLE_THROTTLE_SECONDS"] !== undefined;
  const ms = explicitSeconds || parsed <= 1000 ? parsed * 1000 : parsed;
  return Math.min(IDLE_THROTTLE_MAX_MS, Math.max(IDLE_THROTTLE_MIN_MS, Math.floor(ms)));
}
