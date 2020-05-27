// Copyright IBM Corp. 2018,2020. All Rights Reserved.
// Node module: @loopback/context
// This file is licensed under the MIT License.
// License text available at https://opensource.org/licenses/MIT

import {DecoratorFactory} from '@loopback/metadata';
import debugModule from 'debug';
import {Binding} from './binding';
import {BindingSelector} from './binding-filter';
import {Context} from './context';
import {Injection, InjectionMetadata} from './inject';
import {BoundValue, tryWithFinally, ValueOrPromise} from './value-promise';

const debugSession = debugModule('loopback:context:resolver:session');
const getTargetName = DecoratorFactory.getTargetName;

/**
 * A function to be executed with the resolution session
 */
export type ResolutionAction = (
  session: ResolutionSession,
) => ValueOrPromise<BoundValue>;

/**
 * Wrapper for bindings tracked by resolution sessions
 */
export interface BindingElement {
  type: 'binding';
  value: Readonly<Binding>;
}

/**
 * Wrapper for injections tracked by resolution sessions
 */
export interface InjectionElement {
  type: 'injection';
  value: Readonly<Injection>;
}

export interface InjectionDescriptor {
  targetName: string;
  bindingSelector: BindingSelector;
  metadata: InjectionMetadata;
}

/**
 * Binding or injection elements tracked by resolution sessions
 */
export type ResolutionElement = BindingElement | InjectionElement;

/**
 * Type guard for binding elements
 * @param element - A resolution element
 */
function isBinding(
  element: ResolutionElement | undefined,
): element is BindingElement {
  return element != null && element.type === 'binding';
}

/**
 * Type guard for injection elements
 * @param element - A resolution element
 */
function isInjection(
  element: ResolutionElement | undefined,
): element is InjectionElement {
  return element != null && element.type === 'injection';
}

/**
 * Object to keep states for a session to resolve bindings and their
 * dependencies within a context
 */
export class ResolutionSession {
  /**
   * A stack of bindings for the current resolution session. It's used to track
   * the path of dependency resolution and detect circular dependencies.
   */
  readonly stack: ResolutionElement[] = [];

  /**
   * Fork the current session so that a new one with the same stack can be used
   * in parallel or future resolutions, such as multiple method arguments,
   * multiple properties, or a getter function
   * @param session - The current session
   */
  static fork(session?: ResolutionSession): ResolutionSession | undefined {
    if (session === undefined) return undefined;
    const copy = new ResolutionSession();
    copy.stack.push(...session.stack);
    return copy;
  }

  /**
   * Start to resolve a binding within the session
   * @param binding - The current binding
   * @param session - The current resolution session
   */
  private static enterBinding(
    binding: Readonly<Binding>,
    session?: ResolutionSession,
  ): ResolutionSession {
    session = session ?? new ResolutionSession();
    session.pushBinding(binding);
    return session;
  }

  /**
   * Run the given action with the given binding and session
   * @param action - A function to do some work with the resolution session
   * @param binding - The current binding
   * @param session - The current resolution session
   */
  static runWithBinding(
    action: ResolutionAction,
    binding: Readonly<Binding>,
    session?: ResolutionSession,
  ) {
    const resolutionSession = ResolutionSession.enterBinding(binding, session);
    return tryWithFinally(
      () => action(resolutionSession),
      () => resolutionSession.popBinding(),
    );
  }

  /**
   * Push an injection into the session
   * @param injection - The current injection
   * @param session - The current resolution session
   */
  private static enterInjection(
    injection: Readonly<Injection>,
    session?: ResolutionSession,
  ): ResolutionSession {
    session = session ?? new ResolutionSession();
    session.pushInjection(injection);
    return session;
  }

  /**
   * Run the given action with the given injection and session
   * @param action - A function to do some work with the resolution session
   * @param binding - The current injection
   * @param session - The current resolution session
   */
  static runWithInjection(
    action: ResolutionAction,
    injection: Readonly<Injection>,
    session?: ResolutionSession,
  ) {
    const resolutionSession = ResolutionSession.enterInjection(
      injection,
      session,
    );
    return tryWithFinally(
      () => action(resolutionSession),
      () => resolutionSession.popInjection(),
    );
  }

  /**
   * Describe the injection for debugging purpose
   * @param injection - Injection object
   */
  static describeInjection(
    injection: Readonly<Injection>,
  ): InjectionDescriptor {
    const name = getTargetName(
      injection.target,
      injection.member,
      injection.methodDescriptorOrParameterIndex,
    );
    return {
      targetName: name,
      bindingSelector: injection.bindingSelector,
      metadata: injection.metadata,
    };
  }

  /**
   * Push the injection onto the session
   * @param injection - Injection The current injection
   */
  pushInjection(injection: Readonly<Injection>) {
    /* istanbul ignore if */
    if (debugSession.enabled) {
      debugSession(
        'Enter injection:',
        ResolutionSession.describeInjection(injection),
      );
    }
    this.stack.push({type: 'injection', value: injection});
    /* istanbul ignore if */
    if (debugSession.enabled) {
      debugSession('Resolution path:', this.getResolutionPath());
    }
  }

  /**
   * Pop the last injection
   */
  popInjection() {
    const top = this.stack.pop();
    if (!isInjection(top)) {
      throw new Error('The top element must be an injection');
    }

    const injection = top.value;
    /* istanbul ignore if */
    if (debugSession.enabled) {
      debugSession(
        'Exit injection:',
        ResolutionSession.describeInjection(injection),
      );
      debugSession('Resolution path:', this.getResolutionPath() || '<empty>');
    }
    return injection;
  }

  /**
   * Getter for the current injection
   */
  get currentInjection(): Readonly<Injection> | undefined {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      const element = this.stack[i];
      if (isInjection(element)) return element.value;
    }
    return undefined;
  }

  /**
   * Getter for the current binding
   */
  get currentBinding(): Readonly<Binding> | undefined {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      const element = this.stack[i];
      if (isBinding(element)) return element.value;
    }
    return undefined;
  }

  /**
   * Enter the resolution of the given binding. If
   * @param binding - Binding
   */
  pushBinding(binding: Readonly<Binding>) {
    /* istanbul ignore if */
    if (debugSession.enabled) {
      debugSession('Enter binding:', binding.toJSON());
    }

    if (this.stack.find(i => isBinding(i) && i.value === binding)) {
      const msg =
        `Circular dependency detected: ` +
        `${this.getResolutionPath()} --> ${binding.key}`;
      debugSession(msg);
      throw new Error(msg);
    }
    this.stack.push({type: 'binding', value: binding});
    /* istanbul ignore if */
    if (debugSession.enabled) {
      debugSession('Resolution path:', this.getResolutionPath());
    }
  }

  /**
   * Exit the resolution of a binding
   */
  popBinding(): Readonly<Binding> {
    const top = this.stack.pop();
    if (!isBinding(top)) {
      throw new Error('The top element must be a binding');
    }
    const binding = top.value;
    /* istanbul ignore if */
    if (debugSession.enabled) {
      debugSession('Exit binding:', binding?.toJSON());
      debugSession('Resolution path:', this.getResolutionPath() || '<empty>');
    }
    return binding;
  }

  /**
   * Getter for bindings on the stack
   */
  get bindingStack(): Readonly<Binding>[] {
    return this.stack.filter(isBinding).map(e => e.value);
  }

  /**
   * Getter for injections on the stack
   */
  get injectionStack(): Readonly<Injection>[] {
    return this.stack.filter(isInjection).map(e => e.value);
  }

  /**
   * Get the binding path as `bindingA --> bindingB --> bindingC`.
   */
  getBindingPath() {
    return this.bindingStack.map(b => b.key).join(' --> ');
  }

  /**
   * Get the injection path as `injectionA --> injectionB --> injectionC`.
   */
  getInjectionPath() {
    return this.injectionStack
      .map(i => ResolutionSession.describeInjection(i).targetName)
      .join(' --> ');
  }

  private static describe(e: ResolutionElement) {
    switch (e.type) {
      case 'injection':
        return '@' + ResolutionSession.describeInjection(e.value).targetName;
      case 'binding':
        return e.value.key;
    }
  }

  /**
   * Get the resolution path including bindings and injections, for example:
   * `bindingA --> @ClassA[0] --> bindingB --> @ClassB.prototype.prop1
   * --> bindingC`.
   */
  getResolutionPath() {
    return this.stack.map(i => ResolutionSession.describe(i)).join(' --> ');
  }

  toString() {
    return this.getResolutionPath();
  }
}

/**
 * Options for binding/dependency resolution
 */
export interface ResolutionOptions {
  /**
   * A session to track bindings and injections
   */
  session?: ResolutionSession;

  /**
   * A boolean flag to indicate if the dependency is optional. If it's set to
   * `true` and the binding is not bound in a context, the resolution
   * will return `undefined` instead of throwing an error.
   */
  optional?: boolean;

  /**
   * A boolean flag to control if a proxy should be created to apply
   * interceptors for the resolved value. It's only honored for bindings backed
   * by a class.
   */
  asProxyWithInterceptors?: boolean;
}

/**
 * Resolution options or session
 */
export type ResolutionOptionsOrSession = ResolutionOptions | ResolutionSession;

/**
 * Normalize ResolutionOptionsOrSession to ResolutionOptions
 * @param optionsOrSession - resolution options or session
 */
export function asResolutionOptions(
  optionsOrSession?: ResolutionOptionsOrSession,
): ResolutionOptions {
  // backwards compatibility
  if (optionsOrSession instanceof ResolutionSession) {
    return {session: optionsOrSession};
  }
  return optionsOrSession ?? {};
}

/**
 * Contextual metadata for resolution
 */
export interface ResolutionContext<T = unknown> {
  /**
   * The context for resolution
   */
  readonly context: Context;
  /**
   * The binding to be resolved
   */
  readonly binding: Readonly<Binding<T>>;
  /**
   * The options used for resolution
   */
  readonly options: ResolutionOptions;
}

/**
 * Throw a resolution error
 * @param err - The original err
 * @param resolutionContext - Resolution context
 */
export function throwResolutionError(
  err: unknown,
  resolutionContext: ResolutionContext,
): never {
  if (err instanceof ResolutionError) throw err;
  throw new ResolutionError(err, resolutionContext);
}

/**
 * Error for context binding resolutions and dependency injections
 */
export class ResolutionError extends Error {
  /**
   * The root cause of the resolution error
   */
  readonly cause: unknown;
  /**
   * Contextual data for the resolution
   */
  readonly resolutionContext: ResolutionContext;

  constructor(err: unknown, resolutionContext: ResolutionContext) {
    super(ResolutionError.buildMessage(err, resolutionContext));
    this.cause = err;
    // Capture the stack trace and join it with the cause
    Error.captureStackTrace(this, ResolutionError);
    if (err instanceof Error && err.stack) {
      this.stack = `${this.stack}\nCaused by: ${err.stack}`;
    }
    this.name = ResolutionError.name;
    this.resolutionContext = resolutionContext;
  }

  /**
   * Build the error message for the resolution to include more contextual data
   * @param cause - Cause of the error
   * @param resolutionContext - Resolution context
   */
  private static buildMessage(
    cause: unknown,
    resolutionContext: ResolutionContext<unknown>,
  ) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    const bindingKey = resolutionContext.binding.key;
    const contextName = resolutionContext.context.name;
    const resolutionPath =
      resolutionContext.options.session?.getResolutionPath() ?? '';
    const message =
      `Fail to resolve binding '${bindingKey}' in context ` +
      `'${contextName}'. (Path: ${resolutionPath}. Cause: ${reason}.)`;
    return message;
  }

  toJSON() {
    return {
      message: this.message,
      context: this.resolutionContext.context.name,
      binding: this.resolutionContext.binding.key,
      resolutionPath: this.resolutionContext.options.session?.getResolutionPath(),
      cause: String(this.cause),
    };
  }
}
