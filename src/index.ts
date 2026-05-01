const watched: unique symbol = Symbol('watched');
const unwatched: unique symbol = Symbol('unwatched');

function isState(value: unknown): value is State {
  return value instanceof State;
}

function isComputed(value: unknown): value is Computed {
  return value instanceof Computed;
}

function introspectSources(s: Computed | Watcher): (State | Computed)[] {
  if (s instanceof Computed || s instanceof Watcher) {
    return s[SIGNAL].sources.map((s) => s.self);
  }
  throw new TypeError(`value is not a Computed or a Watcher`);
}

function introspectSinks(s: State | Computed): (Computed | Watcher)[] {
  if (isActualSignal(s)) {
    return [...s[SIGNAL].sinks].map((s) => s.self);
  }
  throw new TypeError(`value is not a State or a Computed`);
}

function hasSinks(s: State | Computed): boolean {
  if (!isActualSignal(s)) {
    throw new TypeError(`value is not a State or a Computed`);
  }
  return s[SIGNAL].sinks.size > 0;
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
  return computing?.computing.self || undefined;
}

export type Equals<T> = (this: Signal<T>, one: T, other: T) => boolean;
export type WatchedCallback<T> = (this: Signal<T>) => void;
export type Computation<T> = (this: Signal<T>) => T;

export interface SignalOptions<T> {
  equals?: Equals<T>;
  [watched]?: WatchedCallback<T>;
  [unwatched]?: WatchedCallback<T>;
}

export type StateInstance<T = unknown> = Omit<State<T>, typeof SIGNAL>;

export type StateCtr = {
  new <T>(initialValue: T, options?: SignalOptions<T>): StateInstance<T>;
};

export type ComputedInstance<T = unknown> = Omit<Computed<T>, typeof SIGNAL>;

export type ComputedCtr = {
  new <T>(computation: Computation<T>, options?: SignalOptions<T>): ComputedInstance<T>;
};

export type WatcherCallback = (this: Watcher) => void;

export type WatcherInstance = Omit<Watcher, typeof SIGNAL>;
export type WatcherCtr = {
  new (notify: WatcherCallback): Watcher;
};

class CurrentlyComputing {
  sourcesToDiscard: Set<Source>
  constructor(readonly computing: ComputedImpl){
    this.sourcesToDiscard = new Set(computing.sources);
  }
  
  addSource(source: Source): void {
    if(!this.sourcesToDiscard.delete(source) && this.computing.isWatched){
      source.addSink(this.computing)
    }
    this.computing.addSource(source);
  }
}

type Version = number & { __version__: true};

let frozen = false;
let computing: CurrentlyComputing | null = null;
const watcherNotificationErrors: unknown[] = []

const firstVersion = 0 as Version;
const uninitialized: unique symbol = Symbol('uninitialized');
const state: unique symbol = Symbol('state');
const computed: unique symbol = Symbol('computed');
const watcher: unique symbol = Symbol('watcher');
const SIGNAL: unique symbol = Symbol('SIGNAL');

function nextVersion(version: Version): Version {
  return (version + 1) as Version;
}

type SetSignalValueResult = 'dirty' | 'clean';

function isActualSignal<T>(signal: Signal<T>): signal is State<T> | Computed<T> {
  return signal instanceof State || signal instanceof Computed;
}

type Sink = WatcherImpl | ComputedImpl;
type Source = StateImpl | ComputedImpl;

function throwIfFrozen(): void {
  if (frozen) {
    throw new Error('frozen');
  }
}

class StateImpl<T = unknown> {
  self: State<T>;
  value: T;
  exceptionValue: unknown;
  #equals: Equals<T>;
  watched: WatchedCallback<T> | undefined;
  unwatched: WatchedCallback<T> | undefined;
  sinks: Set<Sink>;
  version: Version;
  constructor(self: State<T>, initialValue: T, options?: SignalOptions<T>) {
    this.self = self;
    this.value = initialValue;
    this.#equals = options?.equals || ((one, other) => Object.is(one, other));
    this.watched = options?.[watched];
    this.unwatched = options?.[unwatched];
    this.sinks = new Set();
    this.version = firstVersion;
  }

  get pending(): boolean {
    return false;
  }

  get clean(): boolean {
    return true;
  }

  traverseAndCompute(version?: Version): SetSignalValueResult {
    if(version !== undefined && this.version > version){
      return 'dirty'
    }
    return 'clean';
  }

  addSink(sink: Sink): void {
    this.sinks.add(sink);
    const watched = this.watched;
    if (this.sinks.size === 1 && watched) {
      frozen = true;
      try {
        watched.apply(this.self);
      } catch {}
      frozen = false;
    }
  }

  removeSink(sink: Sink): void {
    this.sinks.delete(sink)
    const unwatchedCallback = this.unwatched;
    if (this.sinks.size === 0 && unwatchedCallback) {
      frozen = true;
      try {
        unwatchedCallback.apply(this.self);
      } catch {}
      frozen = false;
    }
  }

  findChanges(): void {}

  set(value: T): void {
    throwIfFrozen();
    const setValueResult = this.#setValue(value);
    if (setValueResult === 'clean') {
      return undefined;
    }
    if (computing === null) {
      this.version = nextVersion(this.version);
    }

    watcherNotificationErrors.length = 0;
    frozen = true;
    for (const sink of this.sinks) {
      sink.notifySourceChanged();
    }
    frozen = false;
    if (watcherNotificationErrors.length > 0) {
      throw new AggregateError(watcherNotificationErrors);
    }
  }

  get(): T {
    throwIfFrozen();
    if (computing) {
      computing.addSource(this as Source);
    }
    if (this.exceptionValue !== undefined) {
      throw this.exceptionValue;
    }
    return this.value;
  }

  #setValue(newValue: T): SetSignalValueResult {
    try {
      if (this.#equals.apply(this.self, [newValue, this.value])) {
        return 'clean';
      }
      this.value = newValue;
      this.exceptionValue = undefined;
    } catch (e) {
      this.exceptionValue = e;
    }
    return 'dirty';
  }
}

type ComputedState = 'clean' | 'checked' | 'computing' | 'dirty';

class ComputedImpl<T = unknown> {
  self: Computed<T>;
  value: T | typeof uninitialized;
  exceptionValue: unknown;
  #equals: Equals<T>;
  watched: WatchedCallback<T> | undefined;
  unwatched: WatchedCallback<T> | undefined;
  sinks: Set<Sink>;
  sources: Source[];
  sourceVersions: Version[];
  isWatched: boolean;
  version: Version;
  state: ComputedState;
  computation: Computation<T>;
  constructor(self: Computed<T>, computation: Computation<T>, options?: SignalOptions<T>) {
    this.self = self;
    this.value = uninitialized;
    this.#equals = options?.equals || ((one, other) => Object.is(one, other));
    this.watched = options?.[watched];
    this.unwatched = options?.[unwatched];
    this.sinks = new Set();
    this.sources = [];
    this.sourceVersions = [];
    this.isWatched = false;
    this.state = 'dirty';
    this.computation = computation;
    this.version = firstVersion;
  }

  get pending(): boolean {
    return this.state === 'dirty' || this.state === 'checked';
  }

  get clean(): boolean {
    return this.state === 'clean';
  }

  addSink(sink: Sink): void {
    this.sinks.add(sink);

    if (this.sinks.size === 1) {
      const watchedCallback = this.watched;
      if (watchedCallback) {
        frozen = true;
        try {
          watchedCallback.apply(this.self);
        } catch {}
        frozen = false;
      }
      this.isWatched = true;
      for (const source of this.sources) {
        source.addSink(this as Sink);
      }
      this.findChanges();
    }
  }

  removeSink(sink: Sink): void {
    this.sinks.delete(sink);
    if (this.sinks.size === 0) {
      const unwatchedCallback = this.unwatched;
      if (unwatchedCallback) {
        frozen = true;
        try {
          unwatchedCallback.apply(this.self);
        } catch {}
        frozen = false;
      }
      this.isWatched = false;
      for (const source of this.sources) {
        source.removeSink(this as Sink);
      }
    }
  }

  findChanges(): void {
    let sourceHasChanged = false;
    for (let i = 0; i < this.sources.length; i++) {
      const source = this.sources[i];
      const sourceVersion = this.sourceVersions[i];
      const thisSourceHasChanged = source.version > sourceVersion;
      if (thisSourceHasChanged) {
        sourceHasChanged = true;
        break;
      }
    }
    if(sourceHasChanged){
      this.notifySourceChanged();
    }
  }

  addSource(source: Source): void {
    this.sources.push(source);
    this.sourceVersions.push(source.version);
  }

  notifySourceChanged(): void {
    if (this.state === 'clean' || this.state === 'checked') {
      this.state = 'dirty';
    }
    for (const sink of this.sinks) {
      sink.notifySourceNeedsComputation();
    }
  }

  notifySourceNeedsComputation(): void {
    if (this.state === 'clean') {
      this.state = 'checked';
    }
    for (const sink of this.sinks) {
      sink.notifySourceNeedsComputation();
    }
  }

  traverseAndCompute(version?: Version): SetSignalValueResult {
    if(this.isWatched && this.state === 'clean') {
      return 'clean';
    }
    if(this.state === 'dirty') {
      return this.#getComputationResult();
    }
    if(!this.isWatched && version !== undefined && this.version > version){
      return 'dirty';
    }
    let sourceHasChanged = false;
    for(let i = 0; i < this.sources.length; i++) {
      const source = this.sources[i];
      const sourceVersion = this.sourceVersions[i];
      const sourceResult = source.traverseAndCompute(sourceVersion);
      if(sourceResult === 'dirty'){
        sourceHasChanged = true;
        break;
      }
    }
    if(sourceHasChanged) {
      return this.#getComputationResult();
    }
    this.state = 'clean';
    return 'clean';
  }

  get(): T {
    throwIfFrozen();
    if (this.state === 'computing') {
      throw new Error('computing');
    }
    this.traverseAndCompute();
    if (computing) {
      computing.addSource(this as Source);
    }

    if (this.exceptionValue !== undefined) {
      throw this.exceptionValue;
    }
    if (this.value === uninitialized) {
      throw new Error('cannot happen');
    }
    return this.value;
  }

  #getComputationResult(): SetSignalValueResult {
    const previouslyComputing = computing;
    const currentlyComputing = new CurrentlyComputing(this as ComputedImpl);
    this.sources.length = 0;
    this.sourceVersions.length = 0;
    computing = currentlyComputing;;
    this.state = 'computing';
    let setValueResult: SetSignalValueResult = 'dirty';
    try {
      setValueResult = this.#setValue(this.computation.apply(this.self));
    } catch (e) {
      this.exceptionValue = e;
    }

    computing = previouslyComputing;
    for (const sourceToDiscard of currentlyComputing.sourcesToDiscard) {
      sourceToDiscard.removeSink(this as Sink);
    }
    if (setValueResult === 'dirty') {
      this.version = nextVersion(this.version);
    }
    this.state = 'clean';
    return setValueResult;
  }

  #setValue(newValue: T): SetSignalValueResult {
    if (this.value === uninitialized) {
      this.value = newValue;
      return 'dirty';
    }
    try {
      if (this.#equals.apply(this.self, [newValue, this.value])) {
        return 'clean';
      }
      this.value = newValue;
      this.exceptionValue = undefined;
    } catch (e) {
      this.exceptionValue = e;
    }
    return 'dirty';
  }
}

type WatcherState = 'waiting' | 'watching' | 'pending';

class WatcherImpl {
  self: Watcher;
  sources: Source[];
  state: WatcherState;
  #watcherCallback: WatcherCallback;
  constructor(self: Watcher, notify: WatcherCallback) {
    this.self = self;
    this.sources = [];
    this.state = 'waiting';
    this.#watcherCallback = notify;
  }

  notifySourceChanged(): void {
    this.#notify();
  }

  notifySourceNeedsComputation(): void {
    this.#notify();
  }

  #notify(): void {
    if(this.state === 'waiting'){
      return;
    }
    let exception: unknown;
    try {
      this.#watcherCallback.call(this.self);
    } catch (e) {
      exception = e;
    }
    this.state = 'waiting';
    if (exception) {
      watcherNotificationErrors.push(exception);
    }
  }

  notifySourceClean(): void {}

  watch(s: Source[]): void {
    throwIfFrozen();
    for (const sourceToWatch of s) {
      this.sources.push(sourceToWatch);
      sourceToWatch.addSink(this);
    }
    if (this.state === 'waiting') {
      this.state = 'watching';
    }
  }

  unwatch(s: Source[]): void {
    throwIfFrozen();
    for (const sourceToUnwatch of s) {
      const index = this.sources.indexOf(sourceToUnwatch);
      this.sources.splice(index, 1);
      sourceToUnwatch.removeSink(this);
    }
    if (this.sources.length === 0 && this.state === 'watching') {
      this.state = 'waiting';
    }
  }

  getPending(): Source[] {
    return this.sources.filter((s) => s.pending);
  }
}
class Watcher {
  [SIGNAL]: WatcherImpl;
  [watcher]: true = true;
  constructor(notify: WatcherCallback) {
    this[SIGNAL] = new WatcherImpl(this, notify);
  }

  watch(...s: Signal[]): void {
    if (!(this instanceof Watcher)) {
      throw new TypeError(`this is not a Watcher`);
    }

    const sourcesToWatch: Source[] = [];
    for (const value of s) {
      if (!isActualSignal(value)) {
        throw new TypeError(`value is not a Signal: ${value}`);
      }
      sourcesToWatch.push(value[SIGNAL]);
    }
    this[SIGNAL].watch(sourcesToWatch);
  }
  unwatch(...s: Signal[]): void {
    if (!(this instanceof Watcher)) {
      throw new TypeError(`this is not a Watcher`);
    }

    const sourcesToUnwatch: Source[] = [];
    for (const value of s) {
      if (!isActualSignal(value)) {
        throw new TypeError(`value is not a Signal: ${value}`);
      }
      if (!this[SIGNAL].sources.includes(value[SIGNAL])) {
        throw new Error(`signal is not watched by this Watcher: ${value}`);
      }
      sourcesToUnwatch.push(value[SIGNAL]);
    }
    this[SIGNAL].unwatch(sourcesToUnwatch);
  }
  getPending(): Signal[] {
    if (!(this instanceof Watcher)) {
      throw new TypeError(`this is not a Watcher`);
    }
    return this[SIGNAL].getPending().map((s) => s.self);
  }
}

class State<T = unknown> {
  readonly [SIGNAL]: StateImpl<T>;
  readonly [state] = true;
  constructor(initialValue: T, options?: SignalOptions<T>) {
    this[SIGNAL] = new StateImpl(this, initialValue, options);
  }

  get(): T {
    if (!(this instanceof State)) {
      throw new TypeError(`this is not a State`);
    }
    return this[SIGNAL].get();
  }

  set(value: T) {
    if (!(this instanceof State)) {
      throw new TypeError(`this is not a State`);
    }
    this[SIGNAL].set(value);
  }
}

class Computed<T = unknown> {
  [SIGNAL]: ComputedImpl<T>;
  readonly [computed] = true;
  constructor(computation: Computation<T>, options?: SignalOptions<T>) {
    this[SIGNAL] = new ComputedImpl(this, computation, options);
  }

  get(): T {
    if (!(this instanceof Computed)) {
      throw new TypeError(`this is not a Computed`);
    }
    return this[SIGNAL].get();
  }
}

export abstract class Signal<T = unknown> {
  abstract get(): T;
  static State: StateCtr;
  static Computed: ComputedCtr;
  static isState: (value: unknown) => value is StateInstance;
  static isComputed: (value: unknown) => value is ComputedInstance;
  static subtle: {
    readonly watched: symbol;
    readonly unwatched: symbol;
    Watcher: WatcherCtr;
    introspectSources(s: ComputedInstance | WatcherInstance): (StateInstance | ComputedInstance)[];
    introspectSinks(s: StateInstance | ComputedInstance): (ComputedInstance | WatcherInstance)[];
    hasSinks(s: StateInstance | ComputedInstance): boolean;
    untrack<T>(cb: () => T): T;
    currentComputed(): ComputedInstance | undefined;
  };
  static {
    this.State = State;
    this.Computed = Computed;
    this.subtle = {
      watched,
      unwatched,
      Watcher: Watcher,
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
