import { AutonomousForager, PreemptedError, type PreemptionProbe } from "./autonomousForager";
import { clearCurrentProcess, setCurrentProcess } from "./heartbeat";
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
/** Gap between foraging passes once the previous one finished. */
const IDLE_PASS_GAP_MS = 60_000;

/** The two tiers. */
export type TaskTier = "priority" | "idle";

/** How a priority task ended. */
export type TaskStatus = "success" | "failure" | "skipped";

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
  /** Overridable for tests; defaults to the 15s Mothership poll. */
  priorityPollMs?: number;
  /** Overridable for tests; defaults to the gap between foraging passes. */
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

  constructor(private readonly deps: TaskEngineDeps) {
    this.priorityPollMs = deps.priorityPollMs ?? PRIORITY_POLL_MS;
    this.idleGapMs = deps.idleGapMs ?? IDLE_PASS_GAP_MS;
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
      `[Swarm] Task engine started — priority tier polls every ` +
        `${this.priorityPollMs / 1000}s, idle tier forages every ${this.idleGapMs / 1000}s.`,
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
      if (!this.polling && !this.isProcessingPriority) {
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
   * THE IDLE TIER — forage the local database, forever.
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

      // 2. One pass. The probe inside makes this yield at its first checkpoint.
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

      // 3. Breathe. One page load a minute is already a busy node; going faster
      //    turns "autonomous" into "laptop fan", and throttling here is what
      //    leaves the priority loop free to be scheduled promptly.
      await Promise.race([sleep(this.idleGapMs), this.shutdown.promise]);
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
      while (this.running && this.queue.length > 0) {
        const task = this.queue.shift();
        if (!task) break;
        await this.runPriorityTask(task);
      }
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
