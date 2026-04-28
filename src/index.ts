const watched: unique symbol = Symbol('watched');
const unwatched: unique symbol = Symbol('unwatched');

function isState(value: unknown): value is State {
  return value instanceof StateImpl;
}

function isComputed(value: unknown): value is Signal {
  return value instanceof ComputedImpl;
}

function introspectSources(s: Computed | Watcher): (State | Computed)[] {
  if (s instanceof ComputedImpl || s instanceof WatcherImpl) {
    return s[SIGNAL].sources.slice() as unknown as (State | Computed)[];
  }
  throw new TypeError(`value is not a Computed or a Watcher`);
}

function introspectSinks(s: State | Computed): (Computed | Watcher)[] {
  if (isActualSignal(s)) {
    return s[SIGNAL].sinks.slice() as unknown as (Computed | Watcher)[];
  }
  throw new TypeError(`value is not a State or a Computed`);
}

function hasSinks(s: State | Computed): boolean {
  if (!isActualSignal(s)) {
    throw new TypeError(`value is not a State or a Computed`);
  }
  return s[SIGNAL].sinks.length > 0;
}

function untrack<T>(cb: () => T): T {
  const previousComputing = computing;
  computing = null;
  try {
    return cb();
  } finally {
    computing = previousComputing;
  }
}

function currentComputed(): Computed | undefined {
  return computing || undefined;
}

export interface State<T = unknown> extends Signal<T> {
  readonly [State]: true;
  set(value: T): void;
}

export interface Computed<T = unknown> extends Signal<T> {
  readonly [Computed]: true;
}

export type Equals<T> = (this: Signal<T>, one: T, other: T) => boolean;
export type WatchedCallback<T> = (this: Signal<T>) => void;
export type Computation<T> = (this: Signal<T>) => T;

export interface SignalOptions<T> {
  equals?: Equals<T>;
  [watched]?: WatchedCallback<T>;
  [unwatched]?: WatchedCallback<T>;
}

export type StateCtr = {
  new <T>(initialValue: T, options?: SignalOptions<T>): State<T>;
};

export type ComputedCtr = {
  new <T>(computation: Computation<T>, options?: SignalOptions<T>): Computed<T>;
};

export type WatcherCallback = (this: Watcher) => void;

export interface Watcher {
  readonly [Watcher]: true;
  watch(...s: Signal[]): void;
  unwatch(...s: Signal[]): void;
  getPending(): Signal[];
}

export type WatcherCtr = {
  new (notify: WatcherCallback): Watcher;
};

type Version = number | undefined;

let frozen = false;
let computing: ComputedImpl | null = null;
let version: Version = 0;

const uninitialized: unique symbol = Symbol('uninitialized');
const State: unique symbol = Symbol('State');
const Computed: unique symbol = Symbol('Computed');
const Watcher: unique symbol = Symbol('Watcher');
const SIGNAL: unique symbol = Symbol('SIGNAL');

function nextVersion(): Version {
  if (version === undefined) {
    version = 0;
    return version;
  }
  return version++;
}

function isNewer(version: Version, thanVersion: Version): boolean {
  if (version === undefined) {
    return false;
  }
  if (thanVersion === undefined) {
    return true;
  }
  return version > thanVersion;
}

type SetSignalValueResult = 'dirty' | 'clean';

function setSignalValue<T>(
  withValue: SignalImpl<T>,
  value: undefined,
  exception: unknown,
): SetSignalValueResult;
function setSignalValue<T>(withValue: SignalImpl<T>, value: T): SetSignalValueResult;
function setSignalValue<T>(
  withValue: SignalImpl<T>,
  v?: T,
  exception?: unknown,
): SetSignalValueResult {
  const signal = withValue[SIGNAL];
  if (exception === undefined) {
    const value = v as T;
    const currentValue = signal.value;
    if (currentValue === uninitialized) {
      signal.value = value;
      signal.exceptionValue = undefined;
      return 'dirty';
    }
    try {
      if (signal.equals.apply(withValue, [value, currentValue])) {
        return 'clean';
      }
      signal.value = value;
      signal.exceptionValue = undefined;
    } catch (e) {
      signal.exceptionValue = e;
    }
  } else {
    signal.exceptionValue = exception;
  }
  return 'dirty';
}

function isActualSignal<T>(signal: Signal<T>): signal is StateImpl<T> | ComputedImpl<T> {
  return signal instanceof StateImpl || signal instanceof ComputedImpl;
}

type Sink = WatcherImpl | ComputedImpl;
type Source = StateImpl | ComputedImpl;

function throwIfFrozen(): void {
  if (frozen) {
    throw new Error('frozen');
  }
}

function freeze(): void {
  frozen = true;
}

function unfreeze(): void {
  frozen = false;
}

type SignalImpl<T = unknown> = StateImpl<T> | ComputedImpl<T>;

class StateImpl<T = unknown> {
  readonly [SIGNAL]: {
    value: T | typeof uninitialized;
    exceptionValue: unknown;
    equals: Equals<T>;
    watched: WatchedCallback<T> | undefined;
    unwatched: WatchedCallback<T> | undefined;
    sinks: Sink[];
    unwatchedSinks: Sink[];
    version: Version;
  };
  readonly [State] = true;
  constructor(initialValue: T, options?: SignalOptions<T>) {
    this[SIGNAL] = {
      value: initialValue,
      exceptionValue: undefined,
      equals: options?.equals || ((one, other) => Object.is(one, other)),
      watched: options?.[watched],
      unwatched: options?.[unwatched],
      sinks: [],
      unwatchedSinks: [],
      version: nextVersion(),
    };
  }

  addUnwatchedSink(sink: Sink): void {
    if (!this[SIGNAL].sinks.includes(sink)) {
      this[SIGNAL].unwatchedSinks.push(sink);
    }
  }

  removeUnwatchedSinks(): void {
    this[SIGNAL].unwatchedSinks.splice(0, this[SIGNAL].unwatchedSinks.length);
  }

  removeSink(sink: Sink): void {
    const index = this[SIGNAL].sinks.indexOf(sink);
    if (index === -1) {
      return;
    }
    this[SIGNAL].sinks.splice(index, 1);
    const unwatchedCallback = this[SIGNAL].unwatched;
    if (this[SIGNAL].sinks.length === 0 && unwatchedCallback) {
      freeze();
      try {
        unwatchedCallback.apply(this);
      } catch {}
      unfreeze();
    }
  }

  addSink(sink: Sink): void {
    this[SIGNAL].sinks.push(sink);
    const watched = this[SIGNAL].watched;
    if (this[SIGNAL].sinks.length === 1 && watched) {
      freeze();
      try {
        watched.apply(this);
      } catch {}
      unfreeze();
    }
  }

  findChanges(): void {}

  traverseAndCompute(): SetSignalValueResult {
    return 'clean';
  }

  get() {
    if (!(this instanceof StateImpl)) {
      throw new TypeError(`this is not a State`);
    }
    throwIfFrozen();
    if (computing) {
      computing.addSource(this as Source);
    }
    if (this[SIGNAL].exceptionValue !== undefined) {
      throw this[SIGNAL].exceptionValue;
    }
    return this[SIGNAL].value as T;
  }

  set(value: T) {
    if (!(this instanceof StateImpl)) {
      throw new TypeError(`this is not a State`);
    }
    throwIfFrozen();
    const setValueResult = setSignalValue(this, value);
    if (setValueResult === 'clean') {
      return undefined;
    }
    if (computing === null) {
      this[SIGNAL].version = nextVersion();
    }

    for (const sink of this[SIGNAL].sinks) {
      sink.notifySourceChanged();
    }
    const watchersToNotify = new Set(
      this[SIGNAL].sinks
        .map((s) => s.findWatchersToNotify())
        .reduce<WatcherImpl[]>((a, b) => a.concat([...b]), []),
    );
    const errors: unknown[] = [];
    for (const watcherToNotify of watchersToNotify) {
      try {
        watcherToNotify.notify();
      } catch (e) {
        errors.push(e);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors);
    }
  }
}

type ComputedState = 'clean' | 'checked' | 'computing' | 'dirty';

function sourceIsPending(source: Source): boolean {
  if (!(source instanceof ComputedImpl)) {
    return false;
  }
  return source[SIGNAL].state === 'dirty' || source[SIGNAL].state === 'checked';
}

function sourceIsClean(source: Source): boolean {
  if (!(source instanceof ComputedImpl)) {
    return true;
  }
  return source[SIGNAL].state === 'clean';
}

class ComputedImpl<T = unknown> {
  [SIGNAL]: {
    value: T | typeof uninitialized;
    exceptionValue: unknown;
    equals: Equals<T>;
    watched: WatchedCallback<T> | undefined;
    unwatched: WatchedCallback<T> | undefined;
    sinks: Sink[];
    unwatchedSinks: Sink[];
    sources: Source[];
    sourceVersions: Version[];
    isWatched: boolean;
    version: Version;
    state: ComputedState;
    computation: Computation<T>;
  };
  readonly [Computed] = true;
  constructor(computation: Computation<T>, options?: SignalOptions<T>) {
    this[SIGNAL] = {
      value: uninitialized,
      exceptionValue: undefined,
      equals: options?.equals || ((one, other) => Object.is(one, other)),
      watched: options?.[watched],
      unwatched: options?.[unwatched],
      sinks: [],
      unwatchedSinks: [],
      version: undefined,
      sources: [],
      sourceVersions: [],
      isWatched: false,
      state: 'dirty',
      computation,
    };
  }

  traverseAndCompute(): SetSignalValueResult {
    if (this[SIGNAL].state === 'checked') {
      for (const source of this[SIGNAL].sources) {
        const sourceResult = source.traverseAndCompute();
        if (sourceResult === 'dirty') {
          break;
        }
      }
    }
    if (this[SIGNAL].state === 'clean') {
      return 'clean';
    }
    if (this[SIGNAL].state === 'dirty') {
      return this.compute();
    }
    return 'dirty';
  }

  compute(): SetSignalValueResult {
    const computationResult = this.#getComputationResult();
    if (computationResult === 'clean') {
      this.#notifySinksThisClean();
    } else {
      this.#notifySinksThisChanged();
    }
    return computationResult;
  }

  notifySourceClean(): void {
    if (!this[SIGNAL].sources.every((s) => sourceIsClean(s))) {
      return;
    }
    if (this[SIGNAL].state === 'checked') {
      this[SIGNAL].state = 'clean';
      this.#notifySinksThisClean();
    }
  }

  notifySourceChanged(): void {
    if (this[SIGNAL].state === 'clean' || this[SIGNAL].state === 'checked') {
      this[SIGNAL].state = 'dirty';
    }
    for (const sink of this[SIGNAL].sinks) {
      sink.notifySourceNeedsComputation();
    }
    for (const unwatchedSink of this[SIGNAL].unwatchedSinks) {
      unwatchedSink.notifySourceNeedsComputation();
    }
  }

  notifySourceNeedsComputation(): void {
    if (this[SIGNAL].state === 'clean') {
      this[SIGNAL].state = 'checked';
    }
    for (const sink of this[SIGNAL].sinks) {
      sink.notifySourceNeedsComputation();
    }
    for (const unwatchedSink of this[SIGNAL].unwatchedSinks) {
      unwatchedSink.notifySourceNeedsComputation();
    }
  }

  *findWatchersToNotify(): Iterable<WatcherImpl> {
    for (const sink of this[SIGNAL].sinks) {
      yield* sink.findWatchersToNotify();
    }
  }

  findChanges(): void {
    for (let i = 0; i < this[SIGNAL].sources.length; i++) {
      const source = this[SIGNAL].sources[i];
      source.findChanges();
      const sourceVersion = this[SIGNAL].sourceVersions[i];
      const sourceHasChanged = isNewer(source[SIGNAL].version, sourceVersion);
      if (sourceHasChanged) {
        this.notifySourceChanged();
      }
    }
  }

  addSource(source: Source): void {
    this[SIGNAL].sources.push(source);
    this[SIGNAL].sourceVersions.push(source[SIGNAL].version);
  }

  removeSink(sink: Sink): void {
    const index = this[SIGNAL].sinks.indexOf(sink);
    if (index === -1) {
      return;
    }
    this[SIGNAL].sinks.splice(index, 1);
    if (this[SIGNAL].sinks.length === 0) {
      const unwatchedCallback = this[SIGNAL].unwatched;
      if (unwatchedCallback) {
        freeze();
        try {
          unwatchedCallback.apply(this);
        } catch {}
        unfreeze();
      }
      this[SIGNAL].isWatched = false;
      for (const source of this[SIGNAL].sources) {
        source.removeSink(this as ComputedImpl);
      }
    }
  }

  addSink(sink: Sink): void {
    this[SIGNAL].sinks.push(sink);

    if (this[SIGNAL].sinks.length === 1) {
      const watchedCallback = this[SIGNAL].watched;
      if (watchedCallback) {
        freeze();
        try {
          watchedCallback.apply(this);
        } catch {}
        unfreeze();
      }
      this[SIGNAL].isWatched = true;
      for (const source of this[SIGNAL].sources) {
        source.addSink(this as ComputedImpl);
      }
      this.findChanges();
    }
  }

  addUnwatchedSink(sink?: Sink): void {
    if (sink && !this[SIGNAL].sinks.includes(sink)) {
      this[SIGNAL].unwatchedSinks.push(sink);
    }
    for (const source of this[SIGNAL].sources) {
      source.addUnwatchedSink(this as ComputedImpl);
    }
  }

  removeUnwatchedSinks(): void {
    this[SIGNAL].unwatchedSinks.splice(0, this[SIGNAL].unwatchedSinks.length);
    for (const source of this[SIGNAL].sources) {
      source.removeUnwatchedSinks();
    }
  }

  get(): T {
    if (!(this instanceof ComputedImpl)) {
      throw new TypeError(`this is not a State`);
    }
    throwIfFrozen();
    if (this[SIGNAL].state === 'computing') {
      throw new Error('computing');
    }
    let unwatchedSinksAdded = false;
    if (this[SIGNAL].state === 'clean' && !this[SIGNAL].isWatched) {
      if (computing === null) {
        this.addUnwatchedSink();
        unwatchedSinksAdded = true;
        this.findChanges();
      }
    }
    if (this[SIGNAL].state === 'checked' || this[SIGNAL].state === 'dirty') {
      if (computing === null) {
        this.traverseAndCompute();
      } else {
        this.compute();
      }
    }
    if (unwatchedSinksAdded) {
      this.removeUnwatchedSinks();
    }
    if (computing) {
      computing.addSource(this as ComputedImpl);
    }

    if (this[SIGNAL].exceptionValue !== undefined) {
      throw this[SIGNAL].exceptionValue;
    }
    if (this[SIGNAL].value === uninitialized) {
      throw new Error('cannot happen');
    }
    return this[SIGNAL].value;
  }

  #getComputationResult(): SetSignalValueResult {
    const oldSources = new Set(this[SIGNAL].sources.splice(0, this[SIGNAL].sources.length));
    this[SIGNAL].sourceVersions.splice(0, this[SIGNAL].sourceVersions.length);
    const previouslyComputing = computing;
    computing = this as ComputedImpl;
    this[SIGNAL].state = 'computing';
    let newExceptionValue: unknown;
    let newValue: T = undefined as T;
    try {
      newValue = this[SIGNAL].computation.apply(this);
    } catch (e) {
      newExceptionValue = e;
    }

    const setValueResult =
      newExceptionValue !== undefined
        ? setSignalValue(this, undefined, newExceptionValue)
        : setSignalValue(this, newValue);
    computing = previouslyComputing;
    const newSources = new Set(this[SIGNAL].sources);
    const sourcesToDiscard = oldSources.difference(newSources);
    for (const sourceToDiscard of sourcesToDiscard) {
      sourceToDiscard.removeSink(this as Sink);
    }
    if (this[SIGNAL].isWatched) {
      const newlyAddedSources = newSources.difference(oldSources);
      for (const newlyAddedSource of newlyAddedSources) {
        newlyAddedSource.addSink(this as Sink);
      }
    }
    if (setValueResult === 'dirty') {
      this[SIGNAL].version = nextVersion();
    }
    this[SIGNAL].state = 'clean';
    return setValueResult;
  }

  #notifySinksThisClean(): void {
    for (const sink of this[SIGNAL].sinks) {
      sink.notifySourceClean();
    }
    for (const unwatchedSink of this[SIGNAL].unwatchedSinks) {
      unwatchedSink.notifySourceClean();
    }
  }

  #notifySinksThisChanged(): void {
    for (const sink of this[SIGNAL].sinks) {
      sink.notifySourceChanged();
    }
    for (const unwatchedSink of this[SIGNAL].unwatchedSinks) {
      unwatchedSink.notifySourceChanged();
    }
  }
}

type WatcherState = 'waiting' | 'watching' | 'pending';

class WatcherImpl {
  [SIGNAL]: {
    sources: Source[];
    state: WatcherState;
    notify: WatcherCallback;
  };
  [Watcher]: true = true;
  constructor(notify: WatcherCallback) {
    this[SIGNAL] = {
      sources: [],
      state: 'waiting',
      notify,
    };
  }

  notifySourceNeedsComputation(): void {
    if (this[SIGNAL].state === 'watching') {
      this[SIGNAL].state = 'pending';
    }
  }

  notifySourceChanged(): void {
    if (this[SIGNAL].state === 'watching') {
      this[SIGNAL].state = 'pending';
    }
  }

  notifySourceClean(): void {}

  findWatchersToNotify(): Iterable<WatcherImpl> {
    if (this[SIGNAL].state !== 'pending') {
      return [];
    }
    return [this];
  }

  notify(): void {
    let exception: unknown;
    freeze();
    try {
      this[SIGNAL].notify.call(this);
    } catch (e) {
      exception = e;
    }
    unfreeze();
    this[SIGNAL].state = 'waiting';
    if (exception) {
      throw exception;
    }
  }

  watch(...s: Signal[]): void {
    if (!(this instanceof WatcherImpl)) {
      throw new TypeError(`this is not a Watcher`);
    }
    throwIfFrozen();
    const sourcesToWatch: Source[] = [];
    for (const value of s) {
      if (!isActualSignal(value)) {
        throw new TypeError(`value is not a Signal: ${value}`);
      }
      sourcesToWatch.push(value);
    }
    for (const sourceToWatch of sourcesToWatch) {
      this[SIGNAL].sources.push(sourceToWatch);
      sourceToWatch.addSink(this);
    }
    if (this[SIGNAL].state === 'waiting') {
      this[SIGNAL].state = 'watching';
    }
  }
  unwatch(...s: Signal[]): void {
    if (!(this instanceof WatcherImpl)) {
      throw new TypeError(`this is not a Watcher`);
    }
    throwIfFrozen();
    const sourcesToUnwatch: Source[] = [];
    for (const value of s) {
      if (!isActualSignal(value)) {
        throw new TypeError(`value is not a Signal: ${value}`);
      }
      if (!this[SIGNAL].sources.includes(value)) {
        throw new Error(`signal is not watched by this Watcher: ${value}`);
      }
      sourcesToUnwatch.push(value);
    }
    for (const sourceToUnwatch of sourcesToUnwatch) {
      const index = this[SIGNAL].sources.indexOf(sourceToUnwatch);
      this[SIGNAL].sources.splice(index, 1);
      sourceToUnwatch.removeSink(this);
    }
    if (this[SIGNAL].sources.length === 0 && this[SIGNAL].state === 'watching') {
      this[SIGNAL].state = 'waiting';
    }
  }
  getPending(): Signal[] {
    if (!(this instanceof WatcherImpl)) {
      throw new TypeError(`this is not a Watcher`);
    }
    return this[SIGNAL].sources.filter((s) => sourceIsPending(s));
  }
}

export abstract class Signal<T = unknown> {
  abstract get(): T;
  static State: StateCtr;
  static Computed: ComputedCtr;
  static isState: (value: unknown) => value is State;
  static isComputed: (value: unknown) => value is Signal;
  static subtle: {
    readonly watched: symbol;
    readonly unwatched: symbol;
    Watcher: WatcherCtr;
    introspectSources(s: Computed | Watcher): (State | Computed)[];
    introspectSinks(s: State | Computed): (Signal | Watcher)[];
    hasSinks(s: State | Computed): boolean;
    untrack<T>(cb: () => T): T;
    currentComputed(): Computed | undefined;
  };
  static {
    this.State = StateImpl;
    this.Computed = ComputedImpl;
    this.subtle = {
      watched,
      unwatched,
      Watcher: WatcherImpl,
      introspectSources,
      introspectSinks,
      hasSinks,
      untrack,
      currentComputed,
    };
    this.isState = isState;
    this.isComputed = isComputed;
  }
}
